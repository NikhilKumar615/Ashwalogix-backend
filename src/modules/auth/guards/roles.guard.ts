import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user as
      | {
          platformRole?: string | null;
          membershipRoles?: string[];
        }
      | undefined;

    if (!user) {
      throw new ForbiddenException('Authenticated user context not found');
    }

    if (user.platformRole === 'SUPER_ADMIN') {
      return true;
    }

    const hasRole =
      (user.platformRole && requiredRoles.includes(user.platformRole)) ||
      user.membershipRoles?.some((role) => requiredRoles.includes(role));

    if (!hasRole) {
      throw new ForbiddenException('You do not have access to this resource');
    }

    return true;
  }
}
