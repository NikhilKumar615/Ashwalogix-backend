import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { SECTION_ACCESS_KEY } from '../decorators/section-access.decorator';
import { effectiveSectionAccess } from '../auth-security.util';
import type { JwtPayload } from '../interfaces/jwt-payload.interface';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    const requiredSection = this.reflector.getAllAndOverride<string>(
      SECTION_ACCESS_KEY,
      [context.getHandler(), context.getClass()],
    );

    if ((!requiredRoles || requiredRoles.length === 0) && !requiredSection) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{
      user?: JwtPayload;
      params?: Record<string, unknown>;
      query?: Record<string, unknown>;
      body?: Record<string, unknown>;
    }>();
    const user = request.user;

    if (!user) {
      throw new ForbiddenException('Authenticated user context not found');
    }

    if (user.platformRole === 'SUPER_ADMIN') {
      return true;
    }

    // Platform-only routes (e.g. SUPER_ADMIN) can never be satisfied by
    // organization section access.
    const platformOnly =
      !!requiredRoles?.length &&
      requiredRoles.every((role) => role === 'SUPER_ADMIN');
    if (platformOnly) {
      throw new ForbiddenException('You do not have access to this resource');
    }

    const rawOrganizationId =
      request.params?.organizationId ??
      request.query?.organizationId ??
      request.body?.organizationId;
    const organizationId =
      typeof rawOrganizationId === 'string' ? rawOrganizationId : undefined;

    const hasRole =
      (user.platformRole && requiredRoles?.includes(user.platformRole)) ||
      user.memberships?.some(
        (membership) =>
          (!organizationId || membership.organizationId === organizationId) &&
          requiredRoles?.includes(membership.role),
      );

    // Section access grants entry to a section's routes only. DRIVER
    // memberships never carry section access (see effectiveSectionAccess),
    // and privileged actions are re-checked by role in the services.
    const hasSectionAccess =
      !!requiredSection &&
      user.memberships?.some((membership) => {
        if (organizationId && membership.organizationId !== organizationId)
          return false;
        const access = effectiveSectionAccess(
          membership.role,
          membership.sectionAccess,
        );
        return (
          !!access &&
          (access.fullAccess || access.sections.includes(requiredSection))
        );
      });

    if (!hasRole && !hasSectionAccess) {
      throw new ForbiddenException('You do not have access to this resource');
    }

    // Entity-level authorization runs later in the request. Keep the
    // controller's section so access in one section cannot unlock another.
    if (requiredSection) {
      user.requestedSection = requiredSection;
    }

    return true;
  }
}
