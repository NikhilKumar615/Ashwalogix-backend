import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { RegisterPushDeviceDto } from './dto/register-push-device.dto';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async registerPushDevice(userId: string, input: RegisterPushDeviceDto) {
    return this.prisma.pushDevice.upsert({
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
    });
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
        this.logger.warn(`Expo push request failed with status ${response.status}`);
      }
    } catch (error) {
      this.logger.warn(
        `Expo push request failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }
}
