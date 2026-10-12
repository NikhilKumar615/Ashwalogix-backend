import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DriverStatus, ShipmentStatus } from '@prisma/client';
import { PrismaService } from '../../shared/prisma/prisma.service';
import {
  DriverNotificationsService,
  formatNotificationDate,
} from './driver-notifications.service';
import { NotificationsService } from './notifications.service';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_PICKUP_LEAD_MINUTES = 60;
/** Statuses where the driver has a trip but has not started it yet. */
const NOT_STARTED_STATUSES: ShipmentStatus[] = [
  ShipmentStatus.PLANNED,
  ShipmentStatus.ASSIGNED,
];
/** Licence reminders: 30 days before, 7 days before, and on expiry. */
const LICENCE_THRESHOLDS = [
  { key: 'expired', maxDays: 0 },
  { key: '7d', maxDays: 7 },
  { key: '30d', maxDays: 30 },
] as const;

/**
 * Periodic reminders for drivers: upcoming pickups and expiring driving
 * licences (KYC). Each reminder has a dedupe key, so running several server
 * instances, or restarting, never sends it twice.
 *
 * Note: on hosts that sleep when idle (Render free tier) the job only runs
 * while the server is awake.
 */
@Injectable()
export class NotificationRemindersService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(NotificationRemindersService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly notifications: NotificationsService,
    private readonly driverNotifications: DriverNotificationsService,
  ) {}

  onApplicationBootstrap() {
    if (
      this.config.get<string>('NOTIFICATION_REMINDERS_ENABLED') === 'false' ||
      process.env.JEST_WORKER_ID
    ) {
      return;
    }
    const interval =
      Number(this.config.get('NOTIFICATION_REMINDERS_INTERVAL_MS')) ||
      DEFAULT_INTERVAL_MS;
    this.timer = setInterval(() => void this.runOnce(), interval);
    this.timer.unref();
    // First run shortly after start-up, off the boot path.
    setTimeout(() => void this.runOnce(), 15_000).unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(now = new Date()) {
    if (this.running) return;
    this.running = true;
    try {
      await this.sendPickupReminders(now);
      await this.sendLicenceReminders(now);
    } catch (error) {
      this.logger.warn(
        `Reminder run failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    } finally {
      this.running = false;
    }
  }

  private async sendPickupReminders(now: Date) {
    const leadMinutes =
      Number(this.config.get('PICKUP_REMINDER_LEAD_MINUTES')) ||
      DEFAULT_PICKUP_LEAD_MINUTES;
    const shipments = await this.prisma.shipment.findMany({
      where: {
        status: { in: NOT_STARTED_STATUSES },
        currentDriverId: { not: null },
        plannedPickupAt: {
          gt: now,
          lte: new Date(now.getTime() + leadMinutes * 60_000),
        },
      },
      select: { id: true, currentDriverId: true },
      take: 500,
    });
    for (const shipment of shipments) {
      await this.driverNotifications.pickupReminder(
        shipment.currentDriverId!,
        shipment.id,
      );
    }
  }

  private async sendLicenceReminders(now: Date) {
    const drivers = await this.prisma.driver.findMany({
      where: {
        status: DriverStatus.ACTIVE,
        userId: { not: null },
        licenseExpiry: {
          not: null,
          lte: new Date(now.getTime() + 30 * DAY_MS),
        },
      },
      select: {
        id: true,
        userId: true,
        organizationId: true,
        licenseExpiry: true,
      },
      take: 1000,
    });

    for (const driver of drivers) {
      const expiry = driver.licenseExpiry!;
      const daysLeft = Math.ceil((expiry.getTime() - now.getTime()) / DAY_MS);
      // Only the most urgent threshold reached; older ones are already sent
      // or no longer useful.
      const threshold = LICENCE_THRESHOLDS.find((t) => daysLeft <= t.maxDays);
      if (!threshold) continue;
      // An expired licence is reminded once; nagging daily would be noise.
      if (threshold.key === 'expired' && daysLeft < -30) continue;

      const expiryLabel = formatNotificationDate(expiry);
      await this.notifications.notifyUser(driver.userId!, {
        type: 'KYC',
        organizationId: driver.organizationId,
        title:
          threshold.key === 'expired'
            ? 'Driving licence expired'
            : 'Driving licence expiring soon',
        body:
          threshold.key === 'expired'
            ? `Your driving licence expired on ${expiryLabel}. Renew it and send the new licence to operations to keep getting trips.`
            : `Your driving licence expires on ${expiryLabel} (${daysLeft} day${daysLeft === 1 ? '' : 's'} left). Renew it and share the new licence with operations.`,
        data: { screen: 'Profile', driverId: driver.id },
        dedupeKey: `licence-expiry:${driver.id}:${expiry.toISOString().slice(0, 10)}:${threshold.key}`,
      });
    }
  }
}
