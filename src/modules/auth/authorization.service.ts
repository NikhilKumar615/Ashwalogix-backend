import { ForbiddenException, Injectable } from '@nestjs/common';
import { OrganizationRole, OrganizationStatus, PlatformRole } from '@prisma/client';
import { PrismaService } from '../../shared/prisma/prisma.service';
import type { JwtPayload } from './interfaces/jwt-payload.interface';

type AllowedRole = `${OrganizationRole}` | `${PlatformRole}`;

@Injectable()
export class AuthorizationService {
  constructor(private readonly prisma: PrismaService) {}

  async assertOrganizationAccess(
    user: JwtPayload,
    organizationId: string,
    allowedRoles?: AllowedRole[],
  ) {
    if (user.platformRole === PlatformRole.SUPER_ADMIN) {
      return;
    }

    if (!user.organizationIds.includes(organizationId)) {
      throw new ForbiddenException(
        'You do not have access to this organization',
      );
    }

    if (allowedRoles?.length) {
      const allowedOrganizationRoles = allowedRoles.filter(
        (role): role is OrganizationRole =>
          Object.values(OrganizationRole).includes(role as OrganizationRole),
      );

      const hasAllowedRole = user.memberships.some(
        (membership) =>
          membership.organizationId === organizationId &&
          allowedOrganizationRoles.includes(
            membership.role as OrganizationRole,
          ),
      );

      if (!hasAllowedRole) {
        throw new ForbiddenException(
          'You do not have permission to perform this action',
        );
      }
    }
  }

  async assertOrganizationWriteAccess(
    user: JwtPayload,
    organizationId: string,
    allowedRoles?: AllowedRole[],
  ) {
    await this.assertOrganizationAccess(user, organizationId, allowedRoles);

    if (user.platformRole === PlatformRole.SUPER_ADMIN) {
      return;
    }

    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { status: true },
    });

    if (!organization) {
      throw new ForbiddenException('Organization access could not be resolved');
    }

    if (organization.status !== OrganizationStatus.ACTIVE) {
      throw new ForbiddenException(
        'Your organization is still pending approval. Browsing is allowed, but changes are blocked until approval.',
      );
    }
  }

  async assertShipmentAccess(
    user: JwtPayload,
    shipmentId: string,
    options?: {
      allowedOrganizationRoles?: AllowedRole[];
      allowAssignedDriver?: boolean;
    },
  ) {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id: shipmentId },
      include: {
        currentDriver: {
          select: {
            id: true,
            userId: true,
          },
        },
        assignments: {
          where: {
            driver: {
              userId: user.sub,
            },
          },
          select: {
            id: true,
          },
          take: 1,
        },
      },
    });

    if (!shipment) {
      throw new ForbiddenException('Shipment access could not be resolved');
    }

    if (user.platformRole === PlatformRole.SUPER_ADMIN) {
      return shipment;
    }

    if (!user.organizationIds.includes(shipment.organizationId)) {
      throw new ForbiddenException('You do not have access to this shipment');
    }

    if (options?.allowedOrganizationRoles?.length) {
      const allowedOrganizationRoles = options.allowedOrganizationRoles.filter(
        (role): role is OrganizationRole =>
          Object.values(OrganizationRole).includes(role as OrganizationRole),
      );

      const hasAllowedRole = user.membershipRoles.some((role) =>
        allowedOrganizationRoles.includes(role as OrganizationRole),
      );

      if (hasAllowedRole) {
        return shipment;
      }
    }

    if (
      options?.allowAssignedDriver &&
      (shipment.currentDriver?.userId === user.sub ||
        shipment.assignments.length > 0)
    ) {
      return shipment;
    }

    throw new ForbiddenException('You do not have access to this shipment');
  }

  async assertShipmentWriteAccess(
    user: JwtPayload,
    shipmentId: string,
    options?: {
      allowedOrganizationRoles?: AllowedRole[];
      allowAssignedDriver?: boolean;
    },
  ) {
    const shipment = await this.assertShipmentAccess(user, shipmentId, options);

    if (user.platformRole === PlatformRole.SUPER_ADMIN) {
      return shipment;
    }

    const organization = await this.prisma.organization.findUnique({
      where: { id: shipment.organizationId },
      select: { status: true },
    });

    if (!organization || organization.status !== OrganizationStatus.ACTIVE) {
      throw new ForbiddenException(
        'Your organization is still pending approval. Browsing is allowed, but changes are blocked until approval.',
      );
    }

    return shipment;
  }

  async assertDriverAccess(
    user: JwtPayload,
    driverId: string,
    organizationId: string,
    allowedOrganizationRoles?: AllowedRole[],
  ) {
    if (user.platformRole === PlatformRole.SUPER_ADMIN) {
      return;
    }

    await this.assertOrganizationAccess(user, organizationId);

    const allowedRoles = allowedOrganizationRoles?.filter(
      (role): role is OrganizationRole =>
        Object.values(OrganizationRole).includes(role as OrganizationRole),
    );

    if (
      allowedRoles?.length &&
      user.memberships.some(
        (membership) =>
          membership.organizationId === organizationId &&
          allowedRoles.includes(membership.role as OrganizationRole),
      )
    ) {
      return;
    }

    const driver = await this.prisma.driver.findFirst({
      where: {
        id: driverId,
        organizationId,
      },
      select: {
        userId: true,
      },
    });

    if (!driver || driver.userId !== user.sub) {
      throw new ForbiddenException('You do not have access to this driver');
    }
  }
}
