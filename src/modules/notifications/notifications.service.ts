import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isUniqueConstraintViolation } from '../../shared/codes/entity-code.util';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { RegisterPushDeviceDto } from './dto/register-push-device.dto';

/** A device binding unused for this long may be claimed by any account. */
const STALE_DEVICE_MS = 7 * 24 * 60 * 60 * 1000;
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
/** Expo accepts at most 100 messages per request. */
const EXPO_PUSH_BATCH = 100;
const EXPO_PUSH_TIMEOUT_MS = 10_000;
/** Must match the channel the driver app creates (push-notifications.js). */
const ANDROID_CHANNEL_ID = 'default';
const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;

export type NotificationType =
  | 'SHIPMENT_ASSIGNED'
  | 'SHIPMENT_UNASSIGNED'
  | 'SHIPMENT_UPDATED'
  | 'SHIPMENT_RESCHEDULED'
  | 'SHIPMENT_CANCELLED'
  | 'PICKUP_REMINDER'
  | 'APPLICATION_APPROVED'
  | 'APPLICATION_REJECTED'
  | 'KYC'
  | 'GENERAL';

export type NotificationInput = {
  type: NotificationType;
  title: string;
  body: string;
  /** Small string map; also sent as the push payload (e.g. shipmentId). */
  data?: Record<string, string>;
  organizationId?: string | null;
  /** Creates the notification at most once per key (scheduled reminders). */
  dedupeKey?: string;
};

type ExpoTicket = {
  status?: 'ok' | 'error';
  details?: { error?: string };
};

const NOTIFICATION_SELECT = {
  id: true,
  type: true,
  title: true,
  body: true,
  data: true,
  readAt: true,
  createdAt: true,
} satisfies Prisma.NotificationSelect;

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Registers an Expo push token for the signed-in user. A token already bound
   * to a different account is only transferred when that binding is stale or
   * both accounts belong to a common organization (shared company phone);
   * otherwise one tenant could redirect another user's device notifications.
   */
  async registerPushDevice(userId: string, input: RegisterPushDeviceDto) {
    const existing = await this.prisma.pushDevice.findUnique({
      where: { expoPushToken: input.expoPushToken },
      select: { id: true, userId: true, lastSeenAt: true },
    });

    if (existing && existing.userId !== userId) {
      const stale =
        Date.now() - existing.lastSeenAt.getTime() > STALE_DEVICE_MS;
      if (
        !stale &&
        !(await this.shareAnOrganization(userId, existing.userId))
      ) {
        this.logger.warn(
          `Rejected push token transfer from user ${existing.userId} to ${userId}`,
        );
        throw new ConflictException(
          'This device is registered to another account. Sign out on that account first.',
        );
      }
      this.logger.log(
        `Push token transferred from user ${existing.userId} to ${userId}`,
      );
    }

    const device = await this.prisma.pushDevice.upsert({
      where: { expoPushToken: input.expoPushToken },
      create: {
        userId,
        expoPushToken: input.expoPushToken,
        platform: input.platform,
      },
      update: {
        userId,
        platform: input.platform,
        lastSeenAt: new Date(),
      },
      select: { id: true, platform: true, lastSeenAt: true, createdAt: true },
    });

    return { ...device, registered: true };
  }

  /** Removes the caller's own binding for a token (call on sign-out). */
  async unregisterPushDevice(userId: string, expoPushToken: string) {
    const result = await this.prisma.pushDevice.deleteMany({
      where: { userId, expoPushToken },
    });
    return { removed: result.count > 0 };
  }

  private async shareAnOrganization(userA: string, userB: string) {
    const memberships = await this.prisma.organizationUser.findMany({
      where: { userId: { in: [userA, userB] }, status: 'ACTIVE' },
      select: { userId: true, organizationId: true },
    });
    const orgsOfA = new Set(
      memberships
        .filter((m) => m.userId === userA)
        .map((m) => m.organizationId),
    );
    return memberships.some(
      (m) => m.userId === userB && orgsOfA.has(m.organizationId),
    );
  }

  /* ── Inbox ─────────────────────────────────────────────────────────── */

  /**
   * The caller's notifications, newest first. Also includes notifications
   * about independent-driver applications made with the caller's email or
   * phone, so an approval sent before the account existed shows up after the
   * driver signs in.
   */
  async listForUser(
    userId: string,
    options: { limit?: number; before?: string; unreadOnly?: boolean } = {},
  ) {
    const limit = Math.min(
      Math.max(Number(options.limit) || DEFAULT_PAGE_SIZE, 1),
      MAX_PAGE_SIZE,
    );
    const before = options.before ? new Date(options.before) : null;
    const where: Prisma.NotificationWhereInput = {
      AND: [
        await this.recipientFilter(userId),
        before && !Number.isNaN(before.getTime())
          ? { createdAt: { lt: before } }
          : {},
        options.unreadOnly ? { readAt: null } : {},
      ],
    };

    const rows = await this.prisma.notification.findMany({
      where,
      select: NOTIFICATION_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const items = rows.slice(0, limit);
    return {
      items,
      nextBefore:
        rows.length > limit
          ? items[items.length - 1].createdAt.toISOString()
          : null,
    };
  }

  async unreadCount(userId: string) {
    const count = await this.prisma.notification.count({
      where: { AND: [await this.recipientFilter(userId), { readAt: null }] },
    });
    return { count };
  }

  async markRead(userId: string, notificationId: string) {
    const result = await this.prisma.notification.updateMany({
      where: {
        AND: [
          await this.recipientFilter(userId),
          { id: notificationId, readAt: null },
        ],
      },
      data: { readAt: new Date() },
    });
    if (result.count === 0) {
      const exists = await this.prisma.notification.count({
        where: {
          AND: [await this.recipientFilter(userId), { id: notificationId }],
        },
      });
      if (!exists) throw new NotFoundException('Notification not found');
    }
    return { read: true };
  }

  async markAllRead(userId: string) {
    const result = await this.prisma.notification.updateMany({
      where: { AND: [await this.recipientFilter(userId), { readAt: null }] },
      data: { readAt: new Date() },
    });
    return { updated: result.count };
  }

  private async recipientFilter(
    userId: string,
  ): Promise<Prisma.NotificationWhereInput> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, phone: true },
    });
    const applicationMatches: Prisma.IndependentDriverRegistrationWhereInput[] =
      [];
    if (user?.email) {
      applicationMatches.push({
        email: { equals: user.email, mode: 'insensitive' },
      });
    }
    if (user?.phone) applicationMatches.push({ phone: user.phone });

    return applicationMatches.length
      ? {
          OR: [
            { userId },
            { userId: null, registration: { OR: applicationMatches } },
          ],
        }
      : { userId };
  }

  /* ── Sending ───────────────────────────────────────────────────────── */

  /**
   * Stores a notification for the user and pushes it to their devices.
   * Never throws: notifications must not break the action that caused them.
   * Returns false when nothing was sent (no recipient, or already sent for
   * this dedupe key).
   */
  async notifyUser(userId: string, input: NotificationInput) {
    try {
      const notification = await this.store({ ...input, userId });
      if (!notification) return false;

      const devices = await this.prisma.pushDevice.findMany({
        where: { userId },
        select: { expoPushToken: true },
      });
      await this.push(
        devices.map((d) => d.expoPushToken),
        notification.id,
        input,
      );
      return true;
    } catch (error) {
      this.logger.warn(
        `Notification ${input.type} for user ${userId} failed: ${this.describe(error)}`,
      );
      return false;
    }
  }

  /** As notifyUser, for a driver profile; drivers without a sign-in are skipped. */
  async notifyDriver(driverId: string, input: NotificationInput) {
    const driver = await this.prisma.driver
      .findUnique({
        where: { id: driverId },
        select: { userId: true, organizationId: true },
      })
      .catch(() => null);
    if (!driver?.userId) return false;
    return this.notifyUser(driver.userId, {
      ...input,
      organizationId: input.organizationId ?? driver.organizationId,
    });
  }

  /**
   * Notifies an independent-driver applicant, who has no account yet: pushed
   * to the phone the application was sent from, and kept for the inbox of
   * the account later created with the same email or phone.
   */
  async notifyApplicant(registrationId: string, input: NotificationInput) {
    try {
      const registration =
        await this.prisma.independentDriverRegistration.findUnique({
          where: { id: registrationId },
          select: { expoPushToken: true },
        });
      if (!registration) return false;

      const notification = await this.store({ ...input, registrationId });
      if (!notification) return false;

      await this.push(
        registration.expoPushToken ? [registration.expoPushToken] : [],
        notification.id,
        input,
      );
      return true;
    } catch (error) {
      this.logger.warn(
        `Notification ${input.type} for application ${registrationId} failed: ${this.describe(error)}`,
      );
      return false;
    }
  }

  private async store(
    input: NotificationInput & {
      userId?: string;
      registrationId?: string;
    },
  ) {
    try {
      return await this.prisma.notification.create({
        data: {
          userId: input.userId,
          registrationId: input.registrationId,
          organizationId: input.organizationId ?? undefined,
          type: input.type,
          title: input.title,
          body: input.body,
          data: input.data ?? undefined,
          dedupeKey: input.dedupeKey,
        },
        select: { id: true },
      });
    } catch (error) {
      // Another instance (or an earlier run) already sent this one.
      if (input.dedupeKey && isUniqueConstraintViolation(error)) return null;
      throw error;
    }
  }

  /**
   * Sends through Expo's push service with high priority on the channel the
   * app creates, so Android shows it even when the app is closed. Tokens that
   * Expo reports as no longer registered are removed.
   */
  private async push(
    tokens: string[],
    notificationId: string,
    input: NotificationInput,
  ) {
    const unique = [...new Set(tokens.filter(Boolean))];
    for (let i = 0; i < unique.length; i += EXPO_PUSH_BATCH) {
      const batch = unique.slice(i, i + EXPO_PUSH_BATCH);
      const messages = batch.map((to) => ({
        to,
        title: input.title,
        body: input.body,
        sound: 'default',
        priority: 'high',
        channelId: ANDROID_CHANNEL_ID,
        data: { ...(input.data ?? {}), notificationId, type: input.type },
      }));

      let response: Response;
      try {
        response = await fetch(EXPO_PUSH_URL, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Accept-Encoding': 'gzip, deflate',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(messages),
          signal: AbortSignal.timeout(EXPO_PUSH_TIMEOUT_MS),
        });
      } catch (error) {
        this.logger.warn(`Expo push request failed: ${this.describe(error)}`);
        continue;
      }

      if (!response.ok) {
        this.logger.warn(
          `Expo push request failed with status ${response.status}`,
        );
        continue;
      }

      const body = (await response.json().catch(() => null)) as {
        data?: ExpoTicket[];
      } | null;
      const unregistered = (body?.data ?? [])
        .map((ticket, index) =>
          ticket?.status === 'error' &&
          ticket.details?.error === 'DeviceNotRegistered'
            ? batch[index]
            : null,
        )
        .filter((token): token is string => Boolean(token));
      if (unregistered.length) {
        await this.prisma.pushDevice
          .deleteMany({ where: { expoPushToken: { in: unregistered } } })
          .catch(() => undefined);
      }
    }
  }

  private describe(error: unknown) {
    return error instanceof Error ? error.message : 'unknown error';
  }
}
