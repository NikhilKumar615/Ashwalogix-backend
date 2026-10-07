import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import {
  MembershipStatus,
  OrganizationRole,
  OrganizationStatus,
  PlatformRole,
  UserStatus,
} from '@prisma/client';
import type { Request } from 'express';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { jwtSecret } from '../../../shared/config/runtime-security';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import {
  ACCESS_TOKEN_TYPE,
  effectiveSectionAccess,
  getCachedSession,
  invalidateUserSession,
  passwordFingerprint,
  safeEqual,
  setCachedSession,
} from '../auth-security.util';
import { JwtPayload } from '../interfaces/jwt-payload.interface';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type SessionSnapshot = {
  id: string;
  email: string;
  status: UserStatus;
  platformRole: PlatformRole | null;
  passwordFingerprint: string;
  emailVerifiedAt: Date | null;
  emailVerificationSuspendedAt: Date | null;
  createdAt: Date;
  memberships: {
    organizationId: string;
    role: OrganizationRole;
    status: MembershipStatus;
    sectionAccess: unknown;
    organizationStatus: OrganizationStatus;
  }[];
};

const EMAIL_VERIFICATION_SUSPENDED_MESSAGE =
  'Your account is temporarily suspended until you verify your email. Use the verification link sent during onboarding.';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  private readonly secret: string;
  private readonly cacheTtlMs: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const secret = jwtSecret(configService);
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: secret,
      passReqToCallback: true,
    });
    this.secret = secret;
    const ttl = Number(
      configService.get<string>('AUTH_SESSION_CACHE_TTL_MS') ?? '15000',
    );
    // Cap the cache so revocations/suspensions apply within 30 seconds.
    this.cacheTtlMs = Number.isFinite(ttl)
      ? Math.min(Math.max(ttl, 0), 30_000)
      : 15_000;
  }

  async validate(request: Request, payload: JwtPayload): Promise<JwtPayload> {
    this.assertAccessToken(payload);

    const session = await this.loadSession(payload.sub);

    if (!session) {
      throw new UnauthorizedException('User account no longer exists');
    }

    if (payload.pwv && !safeEqual(payload.pwv, session.passwordFingerprint)) {
      throw new UnauthorizedException(
        'Your session has expired because your password was changed. Please sign in again.',
      );
    }

    if (session.status === UserStatus.SUSPENDED) {
      if (session.emailVerificationSuspendedAt) {
        throw new ForbiddenException(EMAIL_VERIFICATION_SUSPENDED_MESSAGE);
      }
      throw new ForbiddenException('Your account is suspended');
    }

    if (session.status === UserStatus.REJECTED) {
      throw new ForbiddenException('Your account has been rejected');
    }

    await this.enforceEmailVerificationDeadline(session);

    const isSuperAdmin = session.platformRole === PlatformRole.SUPER_ADMIN;
    const usableMemberships = session.memberships.filter(
      (membership) =>
        membership.status === MembershipStatus.ACTIVE &&
        (membership.organizationStatus === OrganizationStatus.ACTIVE ||
          membership.organizationStatus ===
            OrganizationStatus.PENDING_APPROVAL),
    );

    let onboardingOnly = false;
    if (!isSuperAdmin) {
      if (!usableMemberships.length) {
        const suspended = session.memberships.some(
          (membership) =>
            membership.organizationStatus === OrganizationStatus.SUSPENDED,
        );
        throw new ForbiddenException(
          suspended
            ? 'Your organization has been suspended. Contact Ashwa Logix support.'
            : 'No active organization membership is available for this account',
        );
      }

      onboardingOnly = !usableMemberships.some(
        (membership) =>
          membership.organizationStatus === OrganizationStatus.ACTIVE,
      );

      if (
        onboardingOnly &&
        !this.isOnboardingRequestAllowed(
          request,
          usableMemberships.map((membership) => membership.organizationId),
        )
      ) {
        throw new ForbiddenException(
          'Your organization is pending approval. This action becomes available once Ashwa Logix approves your organization.',
        );
      }
    }

    return {
      sub: session.id,
      email: session.email,
      platformRole: session.platformRole ?? null,
      membershipRoles: usableMemberships.map((membership) => membership.role),
      organizationIds: usableMemberships.map(
        (membership) => membership.organizationId,
      ),
      memberships: usableMemberships.map((membership) => ({
        organizationId: membership.organizationId,
        role: membership.role,
        sectionAccess: effectiveSectionAccess(
          membership.role,
          membership.sectionAccess,
        ),
        organizationStatus: membership.organizationStatus,
      })),
      typ: ACCESS_TOKEN_TYPE,
      iat: payload.iat,
      exp: payload.exp,
      onboardingOnly,
    };
  }

  /**
   * Only access tokens may authenticate HTTP APIs. Tracking socket tokens carry
   * typ='tracking'. Legacy tokens without `typ` are accepted only if they do
   * not look like tracking tokens (no shipmentId / rider|customer role).
   */
  private assertAccessToken(payload: JwtPayload) {
    const raw = payload as JwtPayload & {
      shipmentId?: unknown;
      role?: unknown;
    };

    if (raw.typ !== undefined && raw.typ !== ACCESS_TOKEN_TYPE) {
      throw new UnauthorizedException('Invalid access token');
    }

    if (
      raw.typ === undefined &&
      (raw.shipmentId !== undefined ||
        raw.role === 'rider' ||
        raw.role === 'customer')
    ) {
      throw new UnauthorizedException('Invalid access token');
    }

    if (typeof raw.sub !== 'string' || !UUID_PATTERN.test(raw.sub)) {
      throw new UnauthorizedException('Invalid access token');
    }
  }

  private async loadSession(userId: string): Promise<SessionSnapshot | null> {
    const cached = getCachedSession<SessionSnapshot>(userId);
    if (cached) {
      return cached;
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        status: true,
        platformRole: true,
        passwordHash: true,
        emailVerifiedAt: true,
        emailVerificationSuspendedAt: true,
        createdAt: true,
        organizationMembers: {
          select: {
            organizationId: true,
            role: true,
            status: true,
            sectionAccess: true,
            organization: { select: { status: true } },
          },
        },
      },
    });

    if (!user) {
      return null;
    }

    const snapshot: SessionSnapshot = {
      id: user.id,
      email: user.email,
      status: user.status,
      platformRole: user.platformRole,
      passwordFingerprint: passwordFingerprint(user.passwordHash, this.secret),
      emailVerifiedAt: user.emailVerifiedAt,
      emailVerificationSuspendedAt: user.emailVerificationSuspendedAt,
      createdAt: user.createdAt,
      memberships: user.organizationMembers.map((membership) => ({
        organizationId: membership.organizationId,
        role: membership.role,
        status: membership.status,
        sectionAccess: membership.sectionAccess,
        organizationStatus: membership.organization.status,
      })),
    };

    setCachedSession(userId, snapshot, this.cacheTtlMs);
    return snapshot;
  }

  private async enforceEmailVerificationDeadline(session: SessionSnapshot) {
    if (
      session.emailVerifiedAt ||
      session.platformRole === PlatformRole.SUPER_ADMIN
    ) {
      return;
    }

    const suspensionHours = Number(
      this.configService.get<string>(
        'EMAIL_VERIFICATION_SUSPEND_AFTER_HOURS',
      ) ?? '72',
    );
    const deadline = new Date(
      session.createdAt.getTime() + suspensionHours * 60 * 60 * 1000,
    );

    if (deadline > new Date()) {
      return;
    }

    await this.prisma.user.update({
      where: { id: session.id },
      data: {
        status: UserStatus.SUSPENDED,
        emailVerificationSuspendedAt: new Date(),
      },
    });
    invalidateUserSession(session.id);
    throw new ForbiddenException(EMAIL_VERIFICATION_SUSPENDED_MESSAGE);
  }

  /**
   * Endpoints reachable while the user's organization is pending approval:
   * the portal's read-only "explore" views for the user's own organization,
   * the profile endpoint, and changing their own password. Everything else
   * (cross-organization lookups, uploads, writes) is blocked until approval.
   */
  private isOnboardingRequestAllowed(
    request: Request,
    organizationIds: string[],
  ) {
    const method = (request.method || 'GET').toUpperCase();
    const path = (request.originalUrl || request.url || '')
      .split('?')[0]
      .replace(/\/+$/, '');

    if (method === 'POST' && path === '/api/auth/change-password') {
      return true;
    }

    if (method !== 'GET' && method !== 'HEAD') {
      return false;
    }

    if (path === '/api/auth/me' || path === '/api/shipments') {
      return true;
    }

    const orgScoped =
      /^\/api\/organizations\/([0-9a-f-]{36})\/(users|company-clients|vehicles|warehouses|inventory-items|inventory-movements)(\/.*)?$/i.exec(
        path,
      ) ??
      /^\/api\/drivers\/organizations\/([0-9a-f-]{36})\/drivers(\/.*)?$/i.exec(
        path,
      );

    if (orgScoped && organizationIds.includes(orgScoped[1].toLowerCase())) {
      return true;
    }

    return false;
  }
}
