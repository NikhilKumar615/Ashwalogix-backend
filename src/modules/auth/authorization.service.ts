import { ForbiddenException, Injectable } from '@nestjs/common';
import {
  OrganizationRole,
  OrganizationStatus,
  PlatformRole,
} from '@prisma/client';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { effectiveSectionAccess } from './auth-security.util';
import type { JwtPayload } from './interfaces/jwt-payload.interface';

type AllowedRole = `${OrganizationRole}` | `${PlatformRole}`;

@Injectable()
export class AuthorizationService {
  constructor(private readonly prisma: PrismaService) {}

  // Kept async: every caller awaits it and future checks may hit the DB.
  // eslint-disable-next-line @typescript-eslint/require-await
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

      if (!hasAllowedRole && !this.hasAnySectionAccess(user, organizationId)) {
        throw new ForbiddenException(
          'You do not have permission to perform this action',
        );
      }
    }
  }

  /**
   * True only for SUPER_ADMIN or an ORG_ADMIN member of the organization.
   * Section access (including fullAccess) never satisfies this check.
   */
  isOrganizationAdmin(user: JwtPayload, organizationId: string) {
    if (user.platformRole === PlatformRole.SUPER_ADMIN) {
      return true;
    }
    return user.memberships.some(
      (membership) =>
        membership.organizationId === organizationId &&
        membership.role === OrganizationRole.ORG_ADMIN,
    );
  }

  assertOrganizationAdmin(
    user: JwtPayload,
    organizationId: string,
    message?: string,
  ) {
    if (!this.isOrganizationAdmin(user, organizationId)) {
      throw new ForbiddenException(
        message ?? 'Only an organization admin can perform this action',
      );
    }
  }

  /** Section access held by the caller in this organization (null for drivers). */
  getSectionAccess(user: JwtPayload, organizationId: string) {
    const membership = user.memberships.find(
      (item) => item.organizationId === organizationId,
    );
    return membership
      ? effectiveSectionAccess(membership.role, membership.sectionAccess)
      : null;
  }

  private hasAnySectionAccess(user: JwtPayload, organizationId: string) {
    return user.memberships.some((membership) => {
      if (membership.organizationId !== organizationId) return false;
      const access = effectiveSectionAccess(
        membership.role,
        membership.sectionAccess,
      );
      if (!access) return false;
      if (access.fullAccess) return true;
      return user.requestedSection
        ? access.sections.includes(user.requestedSection)
        : access.sections.length > 0;
    });
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
        this.inactiveOrganizationMessage(organization.status),
      );
    }
  }

  private inactiveOrganizationMessage(status?: OrganizationStatus | null) {
    switch (status) {
      case OrganizationStatus.PENDING_APPROVAL:
        return 'Your organization is still pending approval. Browsing is allowed, but changes are blocked until approval.';
      case OrganizationStatus.SUSPENDED:
        return 'Your organization has been suspended. Contact Ashwa Logix support.';
      case OrganizationStatus.REJECTED:
        return 'Your organization registration was rejected.';
      default:
        return 'Organization access could not be resolved';
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

      const hasAllowedRole = user.memberships.some(
        (membership) =>
          membership.organizationId === shipment.organizationId &&
          allowedOrganizationRoles.includes(
            membership.role as OrganizationRole,
          ),
      );

      if (hasAllowedRole) {
        return shipment;
      }

      if (this.hasAnySectionAccess(user, shipment.organizationId)) {
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
        this.inactiveOrganizationMessage(organization?.status),
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

    if (this.hasAnySectionAccess(user, organizationId)) {
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
