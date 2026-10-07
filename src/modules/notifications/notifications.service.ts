import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { RegisterPushDeviceDto } from './dto/register-push-device.dto';

/** A device binding unused for this long may be claimed by any account. */
const STALE_DEVICE_MS = 7 * 24 * 60 * 60 * 1000;

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

  async sendDriverShipmentNotification(
    driverId: string,
    title: string,
    body: string,
    data: Record<string, string>,
  ) {
    const driver = await this.prisma.driver.findUnique({
      where: { id: driverId },
      select: { userId: true },
    });

    if (!driver?.userId) return;

    const devices = await this.prisma.pushDevice.findMany({
      where: { userId: driver.userId },
      select: { expoPushToken: true },
    });

    if (!devices.length) return;

    try {
      const response = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip, deflate',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(
          devices.map(({ expoPushToken }) => ({
            to: expoPushToken,
            sound: 'default',
            title,
            body,
            data,
          })),
        ),
      });

      if (!response.ok) {
        this.logger.warn(
          `Expo push request failed with status ${response.status}`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Expo push request failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }
}
