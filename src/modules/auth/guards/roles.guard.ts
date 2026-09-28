import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { SECTION_ACCESS_KEY } from '../decorators/section-access.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const requiredSection = this.reflector.getAllAndOverride<string>(SECTION_ACCESS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if ((!requiredRoles || requiredRoles.length === 0) && !requiredSection) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user as
      | {
          platformRole?: string | null;
          membershipRoles?: string[];
          memberships?: { organizationId: string; sectionAccess?: unknown }[];
          requestedSection?: string;
        }
      | undefined;

    if (!user) {
      throw new ForbiddenException('Authenticated user context not found');
    }

    if (user.platformRole === 'SUPER_ADMIN') {
      return true;
    }

    const hasRole =
      (user.platformRole && requiredRoles?.includes(user.platformRole)) ||
      user.membershipRoles?.some((role) => requiredRoles?.includes(role));

    const organizationId =
      request.params?.organizationId ??
      request.query?.organizationId ??
      request.body?.organizationId;
    const hasSectionAccess = requiredSection && user.memberships?.some((membership) => {
      if (organizationId && membership.organizationId !== organizationId) return false;
      const access = membership.sectionAccess as { fullAccess?: boolean; sections?: unknown } | null;
      return access?.fullAccess === true ||
        (Array.isArray(access?.sections) && access.sections.includes(requiredSection));
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
