import { DriverNotificationsService } from './driver-notifications.service';
import { NotificationsService } from './notifications.service';

type SentMessage = {
  type: string;
  title: string;
  body: string;
  data?: Record<string, string>;
};

describe('NotificationsService', () => {
  const userId = '11111111-1111-4111-8111-111111111111';

  const build = () => {
    const prisma = {
      notification: {
        create: jest.fn().mockResolvedValue({ id: 'n-1' }),
      },
      pushDevice: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { expoPushToken: 'ExponentPushToken[a]' },
            { expoPushToken: 'ExponentPushToken[b]' },
          ]),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    return { prisma, service: new NotificationsService(prisma as never) };
  };

  const fetchMock = jest.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as never;
  });

  it('stores the notification and pushes it on the app channel with high priority', async () => {
    const { prisma, service } = build();
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ data: [{ status: 'ok' }, { status: 'ok' }] }),
    });

    const sent = await service.notifyUser(userId, {
      type: 'SHIPMENT_ASSIGNED',
      title: 'New trip',
      body: 'Pickup at Hosur',
      data: { shipmentId: 's-1' },
    });

    expect(sent).toBe(true);
    const [created] = prisma.notification.create.mock.calls[0] as [
      { data: { userId: string; type: string } },
    ];
    expect(created.data).toMatchObject({ userId, type: 'SHIPMENT_ASSIGNED' });
    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    const messages = JSON.parse(init.body) as Record<string, unknown>[];
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      to: 'ExponentPushToken[a]',
      priority: 'high',
      channelId: 'default',
      data: {
        shipmentId: 's-1',
        notificationId: 'n-1',
        type: 'SHIPMENT_ASSIGNED',
      },
    });
  });

  it('removes tokens Expo reports as no longer registered', async () => {
    const { prisma, service } = build();
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [
            { status: 'ok' },
            { status: 'error', details: { error: 'DeviceNotRegistered' } },
          ],
        }),
    });

    await service.notifyUser(userId, {
      type: 'GENERAL',
      title: 't',
      body: 'b',
    });

    expect(prisma.pushDevice.deleteMany).toHaveBeenCalledWith({
      where: { expoPushToken: { in: ['ExponentPushToken[b]'] } },
    });
  });

  it('sends a deduplicated notification only once', async () => {
    const { prisma, service } = build();
    prisma.notification.create.mockRejectedValue({ code: 'P2002' });

    const sent = await service.notifyUser(userId, {
      type: 'PICKUP_REMINDER',
      title: 't',
      body: 'b',
      dedupeKey: 'pickup-reminder:s-1:x',
    });

    expect(sent).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never throws when the push service is down', async () => {
    const { service } = build();
    fetchMock.mockRejectedValue(new Error('network down'));

    await expect(
      service.notifyUser(userId, { type: 'GENERAL', title: 't', body: 'b' }),
    ).resolves.toBe(true);
  });
});

describe('DriverNotificationsService', () => {
  const shipment = {
    id: 's-1',
    organizationId: 'o-1',
    shipmentCode: 'ACM-SHP-0001',
    plannedPickupAt: new Date('2026-10-14T04:30:00Z'),
    plannedDeliveryAt: null,
    stops: [
      { stopType: 'PICKUP', locationName: 'Hosur Cold Store', city: 'Hosur' },
      { stopType: 'DELIVERY', locationName: 'Peelamedu', city: 'Coimbatore' },
    ],
  };

  const build = () => {
    const prisma = {
      shipment: { findUnique: jest.fn().mockResolvedValue(shipment) },
    };
    const notifications = { notifyDriver: jest.fn().mockResolvedValue(true) };
    return {
      notifications,
      service: new DriverNotificationsService(
        prisma as never,
        notifications as never,
      ),
    };
  };

  it('describes a pickup reschedule in IST with the old time', async () => {
    const { notifications, service } = build();

    await service.shipmentRescheduled('d-1', 's-1', {
      pickupBefore: new Date('2026-10-13T04:30:00Z'),
      pickupAfter: new Date('2026-10-14T04:30:00Z'),
      deliveryBefore: null,
      deliveryAfter: null,
    });

    const [driverId, message] = notifications.notifyDriver.mock.calls[0] as [
      string,
      SentMessage,
    ];
    expect(driverId).toBe('d-1');
    expect(message.type).toBe('SHIPMENT_RESCHEDULED');
    expect(message.title).toBe('Pickup rescheduled · ACM-SHP-0001');
    expect(message.body).toMatch(/14 Oct, 10:00 am \(was 13 Oct, 10:00 am\)/i);
    expect(message.data).toEqual({
      shipmentId: 's-1',
      shipmentCode: 'ACM-SHP-0001',
    });
  });

  it('does not notify when the schedule did not change', async () => {
    const { notifications, service } = build();
    const same = new Date('2026-10-14T04:30:00Z');

    await service.shipmentRescheduled('d-1', 's-1', {
      pickupBefore: same,
      pickupAfter: new Date(same),
      deliveryBefore: null,
      deliveryAfter: null,
    });

    expect(notifications.notifyDriver).not.toHaveBeenCalled();
  });

  it('names the pickup and drop in a new-trip notification', async () => {
    const { notifications, service } = build();

    await service.shipmentAssigned('d-1', 's-1');

    const [, message] = notifications.notifyDriver.mock.calls[0] as [
      string,
      SentMessage,
    ];
    expect(message.body).toMatch(
      /^Pickup at Hosur Cold Store, Hosur on 14 Oct, 10:00 am → Peelamedu, Coimbatore\.$/i,
    );
  });
});
