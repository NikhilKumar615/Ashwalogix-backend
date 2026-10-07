import { BadRequestException } from '@nestjs/common';
import { DocumentEntityType } from '@prisma/client';
import { DocumentsService } from './documents.service';
import { detectPublicUploadMimeType } from './documents-upload-policy';

describe('DocumentsService', () => {
  const orgId = '11111111-1111-4111-8111-111111111111';
  const otherOrgId = '22222222-2222-4222-8222-222222222222';
  const shipmentId = '33333333-3333-4333-8333-333333333333';
  const config = {
    get: (key: string) =>
      ({
        CLOUDINARY_CLOUD_NAME: 'cloud',
        CLOUDINARY_API_KEY: 'key',
        CLOUDINARY_API_SECRET: 'secret',
      })[key],
  };

  const build = () => {
    const prisma = {
      document: {
        create: jest
          .fn()
          .mockImplementation(({ data }: { data: unknown }) =>
            Promise.resolve(data),
          ),
      },
    };
    return {
      prisma,
      service: new DocumentsService(prisma as never, config as never),
    };
  };

  const baseInput = {
    organizationId: orgId,
    shipmentId,
    entityType: DocumentEntityType.SHIPMENT,
    entityId: shipmentId,
    documentType: 'POD_PHOTO_1',
    fileName: 'pod.jpg',
    storageBucket: 'cloud',
  };

  it('accepts the key issued by generateUploadUrl and forces uploadedBy/status', async () => {
    const { service, prisma } = build();
    const target = service.generateUploadUrl({
      organizationId: orgId,
      entityType: DocumentEntityType.SHIPMENT,
      entityId: shipmentId,
      shipmentId,
      documentType: 'POD_PHOTO_1',
      fileName: 'pod photo.jpg',
      mimeType: 'image/jpeg',
    });

    expect(target.uploadFields.allowed_formats).toContain('jpg');

    await service.createDocument(
      {
        ...baseInput,
        storageKey: target.storageKey,
        status: 'DELETED',
        uploadedBy: otherOrgId,
      },
      'user-1',
    );

    const [args] = prisma.document.create.mock.calls[0] as [
      { data: { status: string; uploadedBy: string; storageKey: string } },
    ];
    expect(args.data.status).toBe('UPLOADED');
    expect(args.data.uploadedBy).toBe('user-1');
    expect(args.data.storageKey).toBe(target.storageKey);
  });

  it('rejects storage keys belonging to another organization or entity', async () => {
    const { service } = build();

    await expect(
      service.createDocument({
        ...baseInput,
        storageKey: `organizations/${otherOrgId}/shipment/${shipmentId}/x.jpg`,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      service.createDocument({
        ...baseInput,
        storageKey: 'public/registrations/company-admin/gst/abc.pdf',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      service.createDocument({
        ...baseInput,
        storageKey: `organizations/${orgId}/shipment/${shipmentId}/../../${otherOrgId}/x.jpg`,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects disallowed file types for signed upload targets', () => {
    const { service } = build();
    expect(() =>
      service.generateUploadUrl({
        organizationId: orgId,
        entityType: DocumentEntityType.SHIPMENT,
        entityId: shipmentId,
        documentType: 'X',
        fileName: 'payload.html',
        mimeType: 'text/html',
      }),
    ).toThrow(BadRequestException);
  });

  it('detects real file types from magic bytes', () => {
    expect(
      detectPublicUploadMimeType(Buffer.from('%PDF-1.7 0000000000', 'latin1')),
    ).toBe('application/pdf');
    expect(
      detectPublicUploadMimeType(
        Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]),
      ),
    ).toBe('image/jpeg');
    expect(
      detectPublicUploadMimeType(Buffer.from('<html><script>x</script>')),
    ).toBeNull();
  });
});
