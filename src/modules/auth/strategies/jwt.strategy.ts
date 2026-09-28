import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PlatformRole, UserStatus } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { JwtPayload } from '../interfaces/jwt-payload.interface';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_SECRET') ?? 'dev-secret',
    });
  }

  async validate(payload: JwtPayload) {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        status: true,
        emailVerifiedAt: true,
        emailVerificationSuspendedAt: true,
        createdAt: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException('User account no longer exists');
    }

    if (user.status === UserStatus.SUSPENDED) {
      if (user.emailVerificationSuspendedAt) {
        throw new ForbiddenException(
          'Your account is temporarily suspended until you verify your email. Use the verification link sent during onboarding.',
        );
      }
      throw new ForbiddenException('Your account is suspended');
    }

    const suspensionHours = Number(
      this.configService.get<string>('EMAIL_VERIFICATION_SUSPEND_AFTER_HOURS') ??
        '72',
    );
    const deadline = new Date(
      user.createdAt.getTime() + suspensionHours * 60 * 60 * 1000,
    );
    if (
      !user.emailVerifiedAt &&
      payload.platformRole !== PlatformRole.SUPER_ADMIN &&
      deadline <= new Date()
    ) {
      await this.prisma.user.update({
        where: { id: payload.sub },
        data: {
          status: UserStatus.SUSPENDED,
          emailVerificationSuspendedAt: new Date(),
        },
      });
      throw new ForbiddenException(
        'Your account is temporarily suspended until you verify your email. Use the verification link sent during onboarding.',
      );
    }

    return payload;
  }
}
