import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  ClientStatus,
  DocumentEntityType,
  DocumentStatus,
  IndependentDriverRegistrationStatus,
  MembershipStatus,
  OrganizationRole,
  OrganizationStatus,
  PaymentCollectionMethod,
  PlanBillingCycle,
  PlatformRole,
  PlanStatus,
  Prisma,
  SubscriptionPaymentStatus,
  SubscriptionStatus,
  UserStatus,
} from '@prisma/client';
import { compare, hash, hashSync } from 'bcryptjs';
import { randomInt, randomUUID } from 'crypto';
import {
  jwtSecret,
  shouldExposeEmailTokens,
} from '../../shared/config/runtime-security';
import { PrismaService } from '../../shared/prisma/prisma.service';
import {
  ACCESS_TOKEN_TYPE,
  AttemptLimiter,
  generateOneTimeToken,
  hashOneTimeToken,
  invalidateAllSessions,
  invalidateUserSession,
  oneTimeTokenLookupValues,
  passwordFingerprint,
} from './auth-security.util';
import {
  formatIndependentDriverCode,
  formatPlatformClientCode,
  isIndependentDriverCode,
  isPlatformClientCode,
  parseIndependentDriverCodeSequence,
  parsePlatformClientCodeSequence,
} from '../../shared/codes/entity-code.util';
import { isPublicRegistrationStorageKey } from '../documents/documents-upload-policy';
import { MailService } from '../mail/mail.service';
import { CreateClientOrganizationDto } from './dto/create-client-organization.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterCompanyAdminDto } from './dto/register-company-admin.dto';
import { RegisterIndependentDriverDto } from './dto/register-independent-driver.dto';
import { SuperAdminRequestOtpDto } from './dto/super-admin-request-otp.dto';
import { SuperAdminVerifyOtpDto } from './dto/super-admin-verify-otp.dto';
import { UpdateClientOrganizationDto } from './dto/update-client-organization.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { JwtPayload } from './interfaces/jwt-payload.interface';

/** A real bcrypt hash used to equalise timing when the account does not exist. */
const DUMMY_PASSWORD_HASH = hashSync(randomUUID(), 10);

/** Per-account super-admin OTP failures: 5 wrong codes => OTP invalidated + 15 min lock. */
const otpAttemptLimiter = new AttemptLimiter(5, 15 * 60_000, 15 * 60_000);
/** Per-email password failures: 10 within 15 min => 15 min lock (applies to unknown emails too). */
const loginAttemptLimiter = new AttemptLimiter(10, 15 * 60_000, 15 * 60_000);

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private independentDriverCodeColumnAvailable: boolean | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly mailService: MailService,
  ) {}

  async registerCompanyAdmin(input: RegisterCompanyAdminDto) {
    // S6: self-registration may only reference files uploaded through the
    // public onboarding upload (never another organization's storage keys).
    const invalidDocument = input.registrationDocuments?.find(
      (document) => !isPublicRegistrationStorageKey(document.storageKey),
    );
    if (invalidDocument) {
      throw new BadRequestException(
        'Registration documents must be uploaded through the onboarding upload',
      );
    }

    const existingUser = await this.prisma.user.findFirst({
      where: {
        OR: [
          { email: input.email.toLowerCase() },
          ...(input.phone ? [{ phone: input.phone }] : []),
        ],
      },
    });

    if (existingUser) {
      throw new BadRequestException(
        'A user with this email or phone already exists',
      );
    }

    const passwordHash = await hash(input.password, 10);

    const verificationToken = generateOneTimeToken();
    const verificationHours = this.getVerificationLinkHours();
    const verificationTokenExpiresAt = new Date(
      Date.now() + verificationHours * 60 * 60 * 1000,
    );

    const result = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          fullName: input.fullName,
          email: input.email.toLowerCase(),
          phone: input.phone,
          passwordHash,
          // Verification is required for email updates, not for initial access.
          status: UserStatus.PENDING_APPROVAL,
          // Only the SHA-256 of the emailed token is stored.
          verificationToken: hashOneTimeToken(verificationToken),
          verificationTokenExpiresAt,
        },
      });

      const organization = await tx.organization.create({
        data: {
          clientCode: await this.generateOrganizationClientCode(tx),
          name: input.organizationName,
          legalName: input.legalName,
          email: input.organizationEmail,
          phone: input.organizationPhone,
          gstNumber: input.gstNumber,
          panNumber: input.panNumber,
          cinNumber: input.cinNumber,
          addressLine1: input.addressLine1,
          addressLine2: input.addressLine2,
          city: input.city,
          state: input.state,
          postalCode: input.postalCode,
          country: input.country,
          status: OrganizationStatus.PENDING_APPROVAL,
          ownerUserId: user.id,
          submittedByUserId: user.id,
        },
      });

      await tx.organizationUser.create({
        data: {
          organizationId: organization.id,
          userId: user.id,
          role: OrganizationRole.ORG_ADMIN,
          status: MembershipStatus.ACTIVE,
        },
      });

      if (input.registrationDocuments?.length) {
        await tx.document.createMany({
          data: input.registrationDocuments.map((document) => ({
            organizationId: organization.id,
            entityType: DocumentEntityType.ORGANIZATION,
            entityId: organization.id,
            documentType: document.documentType,
            fileName: document.fileName,
            storageBucket: document.storageBucket,
            storageKey: document.storageKey,
            mimeType: document.mimeType,
            fileSize: document.fileSize,
            status: DocumentStatus.UPLOADED,
            uploadedBy: user.id,
          })),
        });
      }

      return { user, organization };
    });

    try {
      await this.mailService.sendVerificationEmail({
        to: result.user.email,
        fullName: result.user.fullName,
        token: verificationToken,
      });
    } catch (error) {
      this.logger.error(
        `Registration ${result.user.id} was created but its verification email could not be sent.`,
        error instanceof Error ? error.stack : undefined,
      );
    }

    return {
      message:
        'Registration created. You can sign in while approval is pending. Please verify your email within 72 hours to continue receiving access and email updates.',
      userId: result.user.id,
      organizationId: result.organization.id,
    };
  }

  async registerIndependentDriver(input: RegisterIndependentDriverDto) {
    this.validateIndependentDriverRegistration(input);

    const existingRegistration =
      await this.prisma.independentDriverRegistration.findFirst({
        where: {
          OR: [{ phone: input.phone }, { vehicleNumber: input.vehicleNumber }],
          status: {
            in: ['PENDING_VERIFICATION', 'PENDING_APPROVAL', 'APPROVED'],
          },
        },
      });

    if (existingRegistration) {
      throw new BadRequestException(
        'An independent driver registration already exists with this phone number or vehicle number',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const driverCode = await this.generateIndependentDriverCode(tx);

      const baseData = {
        fullName: input.fullName,
        phone: input.phone,
        email: input.email?.toLowerCase(),
        dateOfBirth: input.dateOfBirth ? new Date(input.dateOfBirth) : null,
        gender: input.gender,
        addressLine1: input.addressLine1,
        addressLine2: input.addressLine2,
        city: input.city,
        state: input.state,
        postalCode: input.postalCode,
        country: input.country,
        homeBaseLocation: input.homeBaseLocation,
        licenseNumber: input.licenseNumber,
        licenseExpiry: new Date(input.licenseExpiry),
        licenseType: input.licenseType,
        licenseIssueDate: input.licenseIssueDate
          ? new Date(input.licenseIssueDate)
          : null,
        licenseIssuingState: input.licenseIssuingState,
        aadhaarNumber: input.aadhaarNumber,
        panNumber: input.panNumber?.toUpperCase(),
        vehicleNumber: input.vehicleNumber.toUpperCase(),
        vehicleType: input.vehicleType,
        vehicleModel: input.vehicleModel,
        vehicleCapacity: input.vehicleCapacity,
        vehicleOwnerName: input.vehicleOwnerName,
        vehicleRegistrationState: input.vehicleRegistrationState,
        fuelType: input.fuelType,
        uploadedDocuments:
          input.uploadedDocuments as unknown as Prisma.InputJsonValue,
        status: 'PENDING_APPROVAL' as const,
      };

      try {
        const registration = await tx.independentDriverRegistration.create({
          data: {
            ...baseData,
            driverCode,
          },
        });
        this.independentDriverCodeColumnAvailable = true;
        return registration;
      } catch (error) {
        if (!this.isIndependentDriverCodeColumnMissing(error)) {
          throw error;
        }

        this.independentDriverCodeColumnAvailable = false;
        this.logger.warn(
          'independent_driver_registrations.driver_code is missing in the database. Falling back to legacy registration mode.',
        );

        const registration = await tx.independentDriverRegistration.create({
          data: baseData,
        });

        return {
          ...registration,
          driverCode: null,
        };
      }
    });
  }

  async verifyEmail(input: VerifyEmailDto) {
    const user = await this.prisma.user.findFirst({
      where: {
        verificationToken: { in: oneTimeTokenLookupValues(input.token) },
      },
    });

    if (!user) {
      throw new BadRequestException('Invalid verification token');
    }

    if (
      user.verificationTokenExpiresAt &&
      user.verificationTokenExpiresAt < new Date()
    ) {
      throw new BadRequestException('Verification token has expired');
    }

    const wasSuspendedForEmailVerification =
      user.emailVerificationSuspendedAt !== null;
    const updatedUser = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerifiedAt: new Date(),
        verificationToken: null,
        verificationTokenExpiresAt: null,
        status: wasSuspendedForEmailVerification
          ? UserStatus.ACTIVE
          : user.status === UserStatus.PENDING_VERIFICATION
            ? UserStatus.PENDING_APPROVAL
            : user.status,
        emailVerificationSuspendedAt: null,
      },
    });
    invalidateUserSession(user.id);

    return {
      message: wasSuspendedForEmailVerification
        ? 'Email verified successfully. Your temporary suspension has been removed and you can sign in again.'
        : 'Email verified successfully. You will now receive account and shipment updates by email.',
      userId: updatedUser.id,
      status: updatedUser.status,
    };
  }

  async login(input: LoginDto) {
    const user = await this.getUserForAuthentication(input.email);

    await this.assertValidPassword(user, input.password, input.email);
    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }

    await this.assertUserCanLogin(user);

    if (user.platformRole === PlatformRole.SUPER_ADMIN) {
      throw new ForbiddenException(
        'SUPER_ADMIN accounts must complete OTP verification to sign in',
      );
    }

    return this.completeLogin(user);
  }

  async requestSuperAdminOtp(input: SuperAdminRequestOtpDto) {
    const user = await this.getUserForAuthentication(input.email);

    await this.assertValidPassword(user, input.password, input.email);
    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }
    await this.assertUserCanLogin(user);

    if (user.platformRole !== PlatformRole.SUPER_ADMIN) {
      throw new ForbiddenException(
        'Only SUPER_ADMIN accounts can use the OTP sign-in flow',
      );
    }

    this.assertOtpNotLocked(user.id);

    const otp = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const ttlMinutes = Number(
      this.configService.get<string>('SUPER_ADMIN_LOGIN_OTP_TTL_MINUTES') ??
        '10',
    );
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMinutes * 60 * 1000);

    try {
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          loginOtpHash: await hash(otp, 10),
          loginOtpExpiresAt: expiresAt,
          loginOtpRequestedAt: now,
        },
      });

      await this.mailService.sendSuperAdminOtpEmail({
        to: user.email,
        fullName: user.fullName,
        otp,
        expiresInMinutes: ttlMinutes,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(`Super-admin OTP request failed: ${message}`, stack);
      throw error;
    }

    return {
      message: 'OTP sent to your email address',
      email: user.email,
      expiresAt,
      // Only ever echoed in non-production with AUTH_EXPOSE_EMAIL_TOKENS=true.
      otp: this.shouldExposeEmailTokens() ? otp : undefined,
    };
  }

  private assertOtpNotLocked(userId: string) {
    const lockedForMs = otpAttemptLimiter.lockedFor(userId);
    if (lockedForMs > 0) {
      throw new HttpException(
        `Too many incorrect OTP attempts. Try again in ${Math.ceil(lockedForMs / 60_000)} minute(s).`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  async verifySuperAdminOtp(input: SuperAdminVerifyOtpDto) {
    const user = await this.getUserForAuthentication(input.email);
    if (!user) {
      throw new UnauthorizedException('Invalid email or OTP');
    }

    await this.assertUserCanLogin(user);

    if (user.platformRole !== PlatformRole.SUPER_ADMIN) {
      throw new ForbiddenException(
        'Only SUPER_ADMIN accounts can use the OTP sign-in flow',
      );
    }

    this.assertOtpNotLocked(user.id);

    if (!user.loginOtpHash || !user.loginOtpExpiresAt) {
      throw new BadRequestException(
        'Request a new OTP before attempting to verify',
      );
    }

    if (user.loginOtpExpiresAt < new Date()) {
      await this.clearLoginOtp(user.id);
      throw new BadRequestException('OTP has expired. Request a new code');
    }

    const otpMatches = await compare(input.otp, user.loginOtpHash);

    if (!otpMatches) {
      const lockedOut = otpAttemptLimiter.recordFailure(user.id);
      if (lockedOut) {
        // Burn the OTP so the remaining guesses cannot be spent on it.
        await this.clearLoginOtp(user.id);
        this.logger.warn(
          `Super-admin OTP locked after repeated failures for user ${user.id}`,
        );
        throw new HttpException(
          'Too many incorrect OTP attempts. The code has been invalidated; request a new one in 15 minutes.',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      throw new UnauthorizedException('Invalid OTP');
    }

    otpAttemptLimiter.reset(user.id);
    await this.clearLoginOtp(user.id);

    return this.completeLogin(user);
  }

  async forgotPassword(email: string) {
    // Identical response whether or not the account exists (no enumeration).
    const genericResponse = {
      message:
        'If an account exists for this email, a password reset link has been sent.',
    };

    const user = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      select: { id: true, email: true, fullName: true, status: true },
    });

    if (!user || user.status === UserStatus.REJECTED) {
      return genericResponse;
    }

    const resetPasswordToken = generateOneTimeToken();
    const resetHours = Number(
      this.configService.get<string>('PASSWORD_RESET_TTL_HOURS') ?? '1',
    );
    const resetPasswordTokenExpiresAt = new Date(
      Date.now() + resetHours * 60 * 60 * 1000,
    );

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        // Only the SHA-256 of the emailed token is stored.
        resetPasswordToken: hashOneTimeToken(resetPasswordToken),
        resetPasswordTokenExpiresAt,
      },
    });

    try {
      await this.mailService.sendPasswordResetEmail({
        to: user.email,
        fullName: user.fullName,
        token: resetPasswordToken,
      });
    } catch (error) {
      // Do not reveal delivery failures (that would confirm the account exists).
      this.logger.error(
        `Password reset email for user ${user.id} could not be sent.`,
        error instanceof Error ? error.stack : undefined,
      );
    }

    if (this.shouldExposeEmailTokens()) {
      // Local testing only: never active in production.
      return {
        ...genericResponse,
        resetToken: resetPasswordToken,
        expiresAt: resetPasswordTokenExpiresAt,
      };
    }

    return genericResponse;
  }

  async resetPassword(token: string, newPassword: string) {
    const user = await this.prisma.user.findFirst({
      where: { resetPasswordToken: { in: oneTimeTokenLookupValues(token) } },
    });

    if (!user) {
      throw new BadRequestException('Invalid reset token');
    }

    if (
      !user.resetPasswordTokenExpiresAt ||
      user.resetPasswordTokenExpiresAt < new Date()
    ) {
      throw new BadRequestException('Reset token has expired');
    }

    const passwordHash = await hash(newPassword, 10);

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        resetPasswordToken: null,
        resetPasswordTokenExpiresAt: null,
        loginOtpHash: null,
        loginOtpExpiresAt: null,
        loginOtpRequestedAt: null,
      },
    });
    // The password fingerprint (pwv) changed, so every existing session for
    // this user is now rejected by JwtStrategy.
    invalidateUserSession(user.id);
    loginAttemptLimiter.reset(user.email.toLowerCase());

    return {
      message:
        'Password reset successful. You can now log in with the new password.',
      userId: user.id,
    };
  }

  /** Logged-in password change; requires the current password. */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, passwordHash: true },
    });

    if (!user?.passwordHash) {
      throw new UnauthorizedException('User not found');
    }

    const lockKey = `change-password:${user.id}`;
    if (loginAttemptLimiter.lockedFor(lockKey) > 0) {
      throw new HttpException(
        'Too many incorrect attempts. Try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (!(await compare(currentPassword, user.passwordHash))) {
      loginAttemptLimiter.recordFailure(lockKey);
      throw new BadRequestException('Current password is incorrect');
    }
    loginAttemptLimiter.reset(lockKey);

    if (await compare(newPassword, user.passwordHash)) {
      throw new BadRequestException(
        'New password must be different from the current password',
      );
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await hash(newPassword, 10),
        resetPasswordToken: null,
        resetPasswordTokenExpiresAt: null,
      },
    });
    invalidateUserSession(user.id);

    // Old tokens (including the caller's) are now invalid; hand back a fresh one.
    const refreshed = await this.getUserForAuthentication(user.email);
    if (!refreshed) {
      throw new UnauthorizedException('User not found');
    }
    const session = await this.completeLogin(refreshed);

    return {
      message: 'Password updated. Other sessions have been signed out.',
      ...session,
    };
  }

  async getCurrentUser(userId: string) {
    // Note: organization client codes are normalized by the super-admin
    // listing endpoints, not on every /auth/me call (that was a write path
    // touching every organization on each request).
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        driverProfile: true,
        organizationMembers: {
          include: {
            organization: {
              include: {
                locations: {
                  orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
                },
                subscriptions: {
                  where: { isCurrent: true },
                  include: { plan: true },
                  orderBy: { createdAt: 'desc' },
                  take: 1,
                },
              },
            },
          },
        },
      },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    return {
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      phone: user.phone,
      platformRole: user.platformRole,
      status: user.status,
      emailVerifiedAt: user.emailVerifiedAt,
      emailVerificationLinkExpiresAt: user.verificationTokenExpiresAt,
      emailVerificationDeadline: user.emailVerifiedAt
        ? null
        : new Date(
            user.createdAt.getTime() +
              this.getVerificationSuspensionHours() * 60 * 60 * 1000,
          ),
      emailVerificationSuspendedAt: user.emailVerificationSuspendedAt,
      approvedAt: user.approvedAt,
      driverProfile: user.driverProfile
        ? {
            id: user.driverProfile.id,
            organizationId: user.driverProfile.organizationId,
            driverCode: user.driverProfile.driverCode,
            fullName: user.driverProfile.fullName,
            phone: user.driverProfile.phone,
            email: user.driverProfile.email,
            status: user.driverProfile.status,
            employmentType: user.driverProfile.employmentType,
            homeBase: user.driverProfile.homeBase,
            licenseNumber: user.driverProfile.licenseNumber,
            licenseExpiry: user.driverProfile.licenseExpiry,
          }
        : null,
      organizationMemberships: user.organizationMembers.map((membership) => ({
        organizationId: membership.organizationId,
        organizationName: membership.organization.name,
        organizationStatus: membership.organization.status,
        role: membership.role,
        membershipStatus: membership.status,
        sectionAccess: membership.sectionAccess,
        organization: {
          id: membership.organization.id,
          name: membership.organization.name,
          clientCode: membership.organization.clientCode,
          legalName: membership.organization.legalName,
          companyType: membership.organization.companyType,
          clientSegment: membership.organization.clientSegment,
          industry: membership.organization.industry,
          clientStatus: membership.organization.clientStatus,
          billingCycle: membership.organization.billingCycle,
          creditAccount: membership.organization.creditAccount,
          priorityClient: membership.organization.priorityClient,
          contactPerson: membership.organization.contactPerson,
          designation: membership.organization.designation,
          contactEmail: membership.organization.contactEmail,
          contactPhone: membership.organization.contactPhone,
          email: membership.organization.email,
          phone: membership.organization.phone,
          gstNumber: membership.organization.gstNumber,
          panNumber: membership.organization.panNumber,
          cinNumber: membership.organization.cinNumber,
          addressLine1: membership.organization.addressLine1,
          addressLine2: membership.organization.addressLine2,
          city: membership.organization.city,
          state: membership.organization.state,
          postalCode: membership.organization.postalCode,
          country: membership.organization.country,
          status: membership.organization.status,
          locations: membership.organization.locations,
          subscription: membership.organization.subscriptions[0] ?? null,
        },
      })),
    };
  }

  async getPendingOrganizations() {
    await this.normalizeOrganizationClientCodes();

    return this.prisma.organization.findMany({
      where: {
        status: OrganizationStatus.PENDING_APPROVAL,
      },
      orderBy: { createdAt: 'asc' },
      include: {
        locations: {
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
        },
        subscriptions: {
          where: { isCurrent: true },
          include: { plan: true },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });
  }

  async getApprovedOrganizationsCount() {
    const count = await this.prisma.organization.count({
      where: {
        status: OrganizationStatus.ACTIVE,
      },
    });

    return { count };
  }

  async getApprovedOrganizations() {
    await this.normalizeOrganizationClientCodes();

    return this.prisma.organization.findMany({
      where: {
        status: OrganizationStatus.ACTIVE,
      },
      orderBy: { name: 'asc' },
      include: {
        locations: {
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
        },
        subscriptions: {
          where: { isCurrent: true },
          include: { plan: true },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });
  }

  async createClientOrganization(
    input: CreateClientOrganizationDto,
    approverUserId: string,
  ) {
    const approver = await this.prisma.user.findUnique({
      where: { id: approverUserId },
    });

    if (approver?.platformRole !== PlatformRole.SUPER_ADMIN) {
      throw new ForbiddenException('Only SUPER_ADMIN can create clients');
    }

    const normalizedEmail = input.contactEmail.toLowerCase();
    const existingUser = await this.prisma.user.findFirst({
      where: {
        OR: [{ email: normalizedEmail }, { phone: input.contactPhone }],
      },
    });

    if (existingUser) {
      throw new BadRequestException(
        'A user with this email or phone already exists',
      );
    }

    const now = new Date();
    const tempPassword = `Temp${randomUUID().replace(/-/g, '').slice(0, 10)}1`;
    const passwordHash = await hash(tempPassword, 10);

    return this.prisma.$transaction(async (tx) => {
      const ownerUser = await tx.user.create({
        data: {
          fullName: input.contactPerson,
          email: normalizedEmail,
          phone: input.contactPhone,
          passwordHash,
          status: UserStatus.ACTIVE,
          emailVerifiedAt: now,
          approvedAt: now,
          approvedByUserId: approverUserId,
        },
      });

      const organization = await tx.organization.create({
        data: {
          name: input.organizationName,
          clientCode: await this.generateOrganizationClientCode(tx),
          legalName: input.legalName,
          companyType: input.companyType,
          clientSegment: input.clientSegment,
          industry: input.industry,
          clientStatus: input.clientStatus ?? ClientStatus.ACTIVE,
          tags: input.tags,
          notes: input.notes,
          billingCycle: input.billingCycle,
          creditAccount: input.creditAccount ?? false,
          priorityClient: input.priorityClient ?? true,
          contactPerson: input.contactPerson,
          designation: input.designation,
          contactEmail: normalizedEmail,
          contactPhone: input.contactPhone,
          email: normalizedEmail,
          phone: input.contactPhone,
          gstNumber: input.gstNumber,
          panNumber: input.panNumber,
          addressLine1: input.branches[0]?.addressLine1,
          addressLine2: input.branches[0]?.addressLine2,
          city: input.branches[0]?.city,
          state: input.branches[0]?.state,
          postalCode: input.branches[0]?.postalCode,
          country: input.branches[0]?.country ?? 'India',
          status: OrganizationStatus.ACTIVE,
          ownerUserId: ownerUser.id,
          submittedByUserId: approverUserId,
          approvedAt: now,
          approvedByUserId: approverUserId,
        },
      });

      await tx.organizationUser.create({
        data: {
          organizationId: organization.id,
          userId: ownerUser.id,
          role: OrganizationRole.ORG_ADMIN,
          status: MembershipStatus.ACTIVE,
        },
      });

      await tx.organizationLocation.createMany({
        data: input.branches.map((branch, index) => ({
          organizationId: organization.id,
          locationType:
            branch.locationType || (index === 0 ? 'HEAD_OFFICE' : 'BRANCH'),
          name: branch.name,
          addressLine1: branch.addressLine1,
          addressLine2: branch.addressLine2,
          city: branch.city,
          state: branch.state,
          postalCode: branch.postalCode,
          country: branch.country ?? 'India',
          gstin: branch.gstin,
          contactPhone: branch.contactPhone,
          isPrimary: branch.isPrimary ?? index === 0,
        })),
      });

      await this.syncOrganizationSubscription(tx, {
        organizationId: organization.id,
        planId: input.subscriptionPlanId,
        createdByUserId: approverUserId,
        requestedStatus: input.subscriptionStatus,
        requestedPaymentStatus: input.subscriptionPaymentStatus,
        requestedPaymentCollectionMethod: input.paymentCollectionMethod,
        notes: input.subscriptionNotes,
      });

      return tx.organization.findUnique({
        where: { id: organization.id },
        include: {
          locations: {
            orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
          },
          subscriptions: {
            where: { isCurrent: true },
            include: { plan: true },
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
      });
    });
  }

  async updateClientOrganization(
    organizationId: string,
    input: UpdateClientOrganizationDto,
    approverUserId: string,
  ) {
    const approver = await this.prisma.user.findUnique({
      where: { id: approverUserId },
    });

    if (approver?.platformRole !== PlatformRole.SUPER_ADMIN) {
      throw new ForbiddenException('Only SUPER_ADMIN can update clients');
    }

    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      include: {
        locations: true,
      },
    });

    if (!organization) {
      throw new BadRequestException('Organization not found');
    }

    const ownerUser = organization.ownerUserId
      ? await this.prisma.user.findUnique({
          where: { id: organization.ownerUserId },
        })
      : null;

    return this.prisma.$transaction(async (tx) => {
      if (ownerUser && (input.contactEmail || input.contactPhone)) {
        await tx.user.update({
          where: { id: ownerUser.id },
          data: {
            fullName: input.contactPerson ?? ownerUser.fullName,
            email: input.contactEmail?.toLowerCase() ?? ownerUser.email,
            phone: input.contactPhone ?? ownerUser.phone,
          },
        });
      }

      await tx.organization.update({
        where: { id: organizationId },
        data: {
          name: input.organizationName,
          legalName: input.legalName,
          companyType: input.companyType,
          clientSegment: input.clientSegment,
          industry: input.industry,
          clientStatus: input.clientStatus,
          tags: input.tags,
          notes: input.notes,
          billingCycle: input.billingCycle,
          creditAccount: input.creditAccount,
          priorityClient: input.priorityClient,
          contactPerson: input.contactPerson,
          designation: input.designation,
          contactEmail: input.contactEmail?.toLowerCase(),
          contactPhone: input.contactPhone,
          email: input.contactEmail?.toLowerCase(),
          phone: input.contactPhone,
          gstNumber: input.gstNumber,
          panNumber: input.panNumber,
          addressLine1:
            input.branches?.[0]?.addressLine1 ?? organization.addressLine1,
          addressLine2:
            input.branches?.[0]?.addressLine2 ?? organization.addressLine2,
          city: input.branches?.[0]?.city ?? organization.city,
          state: input.branches?.[0]?.state ?? organization.state,
          postalCode:
            input.branches?.[0]?.postalCode ?? organization.postalCode,
          country: input.branches?.[0]?.country ?? organization.country,
        },
      });

      if (input.branches) {
        await tx.organizationLocation.deleteMany({
          where: { organizationId },
        });

        await tx.organizationLocation.createMany({
          data: input.branches.map((branch, index) => ({
            organizationId,
            locationType:
              branch.locationType || (index === 0 ? 'HEAD_OFFICE' : 'BRANCH'),
            name: branch.name,
            addressLine1: branch.addressLine1,
            addressLine2: branch.addressLine2,
            city: branch.city,
            state: branch.state,
            postalCode: branch.postalCode,
            country: branch.country ?? 'India',
            gstin: branch.gstin,
            contactPhone: branch.contactPhone,
            isPrimary: branch.isPrimary ?? index === 0,
          })),
        });
      }

      if (
        input.subscriptionPlanId ||
        input.subscriptionStatus ||
        input.subscriptionPaymentStatus ||
        input.paymentCollectionMethod ||
        input.subscriptionNotes
      ) {
        await this.syncOrganizationSubscription(tx, {
          organizationId,
          planId: input.subscriptionPlanId,
          createdByUserId: approverUserId,
          requestedStatus: input.subscriptionStatus,
          requestedPaymentStatus: input.subscriptionPaymentStatus,
          requestedPaymentCollectionMethod: input.paymentCollectionMethod,
          notes: input.subscriptionNotes,
        });
      }

      return tx.organization.findUnique({
        where: { id: organizationId },
        include: {
          locations: {
            orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
          },
          subscriptions: {
            where: { isCurrent: true },
            include: { plan: true },
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
      });
    });
  }

  async getPendingIndependentDrivers() {
    await this.normalizeIndependentDriverCodes();

    if (this.independentDriverCodeColumnAvailable === false) {
      return this.listIndependentDriversWithoutCodeColumn();
    }

    return this.prisma.independentDriverRegistration.findMany({
      where: {
        status: IndependentDriverRegistrationStatus.PENDING_APPROVAL,
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async getIndependentDriverRegistration(registrationId: string) {
    await this.normalizeIndependentDriverCodes();

    if (this.independentDriverCodeColumnAvailable === false) {
      return this.getIndependentDriverRegistrationWithoutCodeColumn(
        registrationId,
      );
    }

    const registration =
      await this.prisma.independentDriverRegistration.findUnique({
        where: { id: registrationId },
      });

    if (!registration) {
      throw new BadRequestException(
        'Independent driver registration not found',
      );
    }

    return registration;
  }

  async approveOrganization(
    organizationId: string,
    approverUserId: string,
    notes?: string,
  ) {
    const approver = await this.prisma.user.findUnique({
      where: { id: approverUserId },
    });

    if (approver?.platformRole !== PlatformRole.SUPER_ADMIN) {
      throw new ForbiddenException(
        'Only SUPER_ADMIN can approve organizations',
      );
    }

    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
    });

    if (!organization) {
      throw new BadRequestException('Organization not found');
    }

    if (organization.status !== OrganizationStatus.PENDING_APPROVAL) {
      throw new BadRequestException(
        'Only pending organizations can be approved',
      );
    }

    const ownerUserId = organization.ownerUserId;
    if (!ownerUserId) {
      throw new BadRequestException(
        'Organization does not have an owner user to approve',
      );
    }

    const ownerUser = await this.prisma.user.findUnique({
      where: { id: ownerUserId },
    });

    if (!ownerUser) {
      throw new BadRequestException('Owner user not found');
    }

    if (!ownerUser.emailVerifiedAt) {
      throw new BadRequestException(
        'Owner user email must be verified before approval',
      );
    }

    const approvedAt = new Date();

    await this.prisma.$transaction(async (tx) => {
      await tx.organization.update({
        where: { id: organizationId },
        data: {
          clientCode:
            organization.clientCode &&
            isPlatformClientCode(organization.clientCode)
              ? organization.clientCode
              : await this.generateOrganizationClientCode(tx, approvedAt),
          status: OrganizationStatus.ACTIVE,
          approvedAt,
          approvedByUserId: approverUserId,
          rejectedAt: null,
          rejectedReason: null,
        },
      });

      await this.syncOrganizationSubscription(tx, {
        organizationId,
        createdByUserId: approverUserId,
        notes: notes ?? null,
      });

      await tx.user.update({
        where: { id: ownerUserId },
        data: {
          status: UserStatus.ACTIVE,
          approvedAt,
          approvedByUserId: approverUserId,
          rejectedAt: null,
          rejectedReason: null,
        },
      });
    });

    invalidateAllSessions();

    // The approval is committed; a mail failure must not turn it into a 500.
    const emailSent = await this.sendMailSafely(
      `organization ${organizationId} approval`,
      () =>
        this.mailService.sendOrganizationApprovedEmail({
          to: ownerUser.email,
          fullName: ownerUser.fullName,
          organizationName: organization.name,
          notes: notes ?? null,
        }),
    );

    return {
      message: 'Organization approved successfully',
      organizationId,
      approvedAt,
      notes: notes ?? null,
      emailSent,
    };
  }

  /** Runs a mail send, logging (not throwing) on failure. Returns whether it succeeded. */
  private async sendMailSafely(context: string, send: () => Promise<void>) {
    try {
      await send();
      return true;
    } catch (error) {
      this.logger.error(
        `Email for ${context} could not be sent.`,
        error instanceof Error ? error.stack : undefined,
      );
      return false;
    }
  }

  async getSuspendedOrganizations() {
    return this.prisma.organization.findMany({
      where: { status: OrganizationStatus.SUSPENDED },
      orderBy: { updatedAt: 'desc' },
      include: {
        locations: {
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
        },
        subscriptions: {
          where: { isCurrent: true },
          include: { plan: true },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });
  }

  /**
   * SUPER_ADMIN: suspend an ACTIVE (or pending) organization. Members are
   * blocked from signing in and from every org-scoped API within ~30 seconds
   * (JwtStrategy session cache TTL); this instance applies it immediately.
   */
  async suspendOrganization(
    organizationId: string,
    actorUserId: string,
    reason?: string,
  ) {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true, name: true, status: true },
    });

    if (!organization) {
      throw new NotFoundException('Organization not found');
    }

    if (organization.status === OrganizationStatus.SUSPENDED) {
      throw new BadRequestException('Organization is already suspended');
    }

    if (
      organization.status !== OrganizationStatus.ACTIVE &&
      organization.status !== OrganizationStatus.PENDING_APPROVAL
    ) {
      throw new BadRequestException(
        'Only active or pending organizations can be suspended',
      );
    }

    const suspendedAt = new Date();
    await this.prisma.organization.update({
      where: { id: organizationId },
      data: { status: OrganizationStatus.SUSPENDED },
    });
    invalidateAllSessions();

    this.logger.warn(
      `Organization ${organizationId} suspended by ${actorUserId} (previous status ${organization.status}). Reason: ${reason?.trim() || '(none given)'}`,
    );

    return {
      message: 'Organization suspended',
      organizationId,
      previousStatus: organization.status,
      status: OrganizationStatus.SUSPENDED,
      suspendedAt,
      reason: reason?.trim() || null,
    };
  }

  /** SUPER_ADMIN: reactivate a SUSPENDED organization (back to ACTIVE). */
  async reactivateOrganization(
    organizationId: string,
    actorUserId: string,
    reason?: string,
  ) {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true, status: true, approvedAt: true },
    });

    if (!organization) {
      throw new NotFoundException('Organization not found');
    }

    if (organization.status !== OrganizationStatus.SUSPENDED) {
      throw new BadRequestException(
        'Only suspended organizations can be reactivated',
      );
    }

    // An organization suspended before it was ever approved goes back to the
    // approval queue instead of becoming ACTIVE without review.
    const nextStatus = organization.approvedAt
      ? OrganizationStatus.ACTIVE
      : OrganizationStatus.PENDING_APPROVAL;

    await this.prisma.organization.update({
      where: { id: organizationId },
      data: { status: nextStatus },
    });
    invalidateAllSessions();

    this.logger.log(
      `Organization ${organizationId} reactivated by ${actorUserId} -> ${nextStatus}. Reason: ${reason?.trim() || '(none given)'}`,
    );

    return {
      message:
        nextStatus === OrganizationStatus.ACTIVE
          ? 'Organization reactivated'
          : 'Organization returned to the pending approval queue',
      organizationId,
      status: nextStatus,
      reactivatedAt: new Date(),
    };
  }

  async rejectOrganization(
    organizationId: string,
    approverUserId: string,
    reason: string,
  ) {
    const approver = await this.prisma.user.findUnique({
      where: { id: approverUserId },
    });

    if (approver?.platformRole !== PlatformRole.SUPER_ADMIN) {
      throw new ForbiddenException('Only SUPER_ADMIN can reject organizations');
    }

    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
    });

    if (!organization) {
      throw new BadRequestException('Organization not found');
    }

    if (organization.status !== OrganizationStatus.PENDING_APPROVAL) {
      throw new BadRequestException(
        'Only pending organizations can be rejected',
      );
    }

    const ownerUser = organization.ownerUserId
      ? await this.prisma.user.findUnique({
          where: { id: organization.ownerUserId },
        })
      : null;

    const rejectedAt = new Date();

    await this.prisma.$transaction(async (tx) => {
      await tx.organization.update({
        where: { id: organizationId },
        data: {
          status: OrganizationStatus.REJECTED,
          approvedAt: null,
          approvedByUserId: null,
          rejectedAt,
          rejectedReason: reason,
        },
      });

      if (organization.ownerUserId) {
        await tx.user.update({
          where: { id: organization.ownerUserId },
          data: {
            status: UserStatus.REJECTED,
            approvedAt: null,
            approvedByUserId: null,
            rejectedAt,
            rejectedReason: reason,
          },
        });
      }
    });

    invalidateAllSessions();

    const emailSent = ownerUser?.email
      ? await this.sendMailSafely(
          `organization ${organizationId} rejection`,
          () =>
            this.mailService.sendOrganizationRejectedEmail({
              to: ownerUser.email,
              fullName: ownerUser.fullName,
              organizationName: organization.name,
              reason,
            }),
        )
      : false;

    return {
      message: 'Organization rejected successfully',
      organizationId,
      rejectedAt,
      reason,
      emailSent,
    };
  }

  async approveIndependentDriver(
    registrationId: string,
    approverUserId: string,
    organizationId?: string,
    notes?: string,
  ) {
    const approver = await this.prisma.user.findUnique({
      where: { id: approverUserId },
    });

    if (approver?.platformRole !== PlatformRole.SUPER_ADMIN) {
      throw new ForbiddenException(
        'Only SUPER_ADMIN can approve independent driver registrations',
      );
    }

    const registration =
      await this.prisma.independentDriverRegistration.findUnique({
        where: { id: registrationId },
      });

    if (!registration) {
      throw new BadRequestException(
        'Independent driver registration not found',
      );
    }

    if (
      registration.status !==
      IndependentDriverRegistrationStatus.PENDING_APPROVAL
    ) {
      throw new BadRequestException(
        'Only pending independent driver registrations can be approved',
      );
    }

    if (organizationId) {
      const organization = await this.prisma.organization.findUnique({
        where: { id: organizationId },
      });

      if (!organization) {
        throw new BadRequestException('Organization not found');
      }

      if (organization.status !== OrganizationStatus.ACTIVE) {
        throw new BadRequestException(
          'Only active organizations can be linked to an approved independent driver registration',
        );
      }
    }

    const approvedAt = new Date();

    await this.prisma.independentDriverRegistration.update({
      where: { id: registrationId },
      data: {
        status: IndependentDriverRegistrationStatus.APPROVED,
        organizationId: organizationId ?? registration.organizationId,
        approvedAt,
        approvedByUserId: approverUserId,
        rejectedAt: null,
        rejectedReason: null,
      },
    });

    const registrationEmail = registration.email;
    if (registrationEmail) {
      await this.sendMailSafely(
        `independent driver ${registrationId} approval`,
        () =>
          this.mailService.sendIndependentDriverApprovedEmail({
            to: registrationEmail,
            fullName: registration.fullName,
            notes: notes ?? null,
          }),
      );
    }

    return {
      message: 'Independent driver registration approved successfully',
      registrationId,
      approvedAt,
      organizationId: organizationId ?? registration.organizationId ?? null,
      notes: notes ?? null,
    };
  }

  async rejectIndependentDriver(
    registrationId: string,
    approverUserId: string,
    reason: string,
  ) {
    const approver = await this.prisma.user.findUnique({
      where: { id: approverUserId },
    });

    if (approver?.platformRole !== PlatformRole.SUPER_ADMIN) {
      throw new ForbiddenException(
        'Only SUPER_ADMIN can reject independent driver registrations',
      );
    }

    const registration =
      await this.prisma.independentDriverRegistration.findUnique({
        where: { id: registrationId },
      });

    if (!registration) {
      throw new BadRequestException(
        'Independent driver registration not found',
      );
    }

    if (
      registration.status !==
      IndependentDriverRegistrationStatus.PENDING_APPROVAL
    ) {
      throw new BadRequestException(
        'Only pending independent driver registrations can be rejected',
      );
    }

    const rejectedAt = new Date();

    await this.prisma.independentDriverRegistration.update({
      where: { id: registrationId },
      data: {
        status: IndependentDriverRegistrationStatus.REJECTED,
        approvedAt: null,
        approvedByUserId: null,
        rejectedAt,
        rejectedReason: reason,
      },
    });

    const registrationEmail = registration.email;
    if (registrationEmail) {
      await this.sendMailSafely(
        `independent driver ${registrationId} rejection`,
        () =>
          this.mailService.sendIndependentDriverRejectedEmail({
            to: registrationEmail,
            fullName: registration.fullName,
            reason,
          }),
      );
    }

    return {
      message: 'Independent driver registration rejected successfully',
      registrationId,
      rejectedAt,
      reason,
    };
  }

  private async assertUserCanLogin(user: {
    id: string;
    status: UserStatus;
    emailVerifiedAt: Date | null;
    emailVerificationSuspendedAt: Date | null;
    createdAt: Date;
    platformRole: PlatformRole | null;
    organizationMembers: {
      organization: { status: OrganizationStatus };
      status: MembershipStatus;
    }[];
  }) {
    if (user.status === UserStatus.SUSPENDED) {
      if (user.emailVerificationSuspendedAt) {
        throw new ForbiddenException(
          'Your account is temporarily suspended until you verify your email. Use the verification link sent during onboarding.',
        );
      }
      throw new ForbiddenException('Your account is suspended');
    }

    const verificationDeadline = new Date(
      user.createdAt.getTime() +
        this.getVerificationSuspensionHours() * 60 * 60 * 1000,
    );
    if (
      !user.emailVerifiedAt &&
      user.platformRole !== PlatformRole.SUPER_ADMIN &&
      verificationDeadline <= new Date()
    ) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          status: UserStatus.SUSPENDED,
          emailVerificationSuspendedAt: new Date(),
        },
      });
      throw new ForbiddenException(
        'Your account is temporarily suspended until you verify your email. Use the verification link sent during onboarding.',
      );
    }

    if (user.status === UserStatus.REJECTED) {
      throw new ForbiddenException('Your account has been rejected');
    }

    if (user.platformRole === PlatformRole.SUPER_ADMIN) {
      return;
    }

    const hasPortalMembership = user.organizationMembers.some(
      (membership) =>
        membership.status === MembershipStatus.ACTIVE &&
        (membership.organization.status === OrganizationStatus.ACTIVE ||
          membership.organization.status ===
            OrganizationStatus.PENDING_APPROVAL),
    );

    if (!hasPortalMembership) {
      const suspended = user.organizationMembers.some(
        (membership) =>
          membership.organization.status === OrganizationStatus.SUSPENDED,
      );
      throw new ForbiddenException(
        suspended
          ? 'Your organization has been suspended. Contact Ashwa Logix support.'
          : 'No active organization membership is available for this account',
      );
    }
  }

  private getVerificationLinkHours() {
    return Number(
      this.configService.get<string>('EMAIL_VERIFICATION_TTL_HOURS') ?? '168',
    );
  }

  private getVerificationSuspensionHours() {
    return Number(
      this.configService.get<string>(
        'EMAIL_VERIFICATION_SUSPEND_AFTER_HOURS',
      ) ?? '72',
    );
  }

  private async syncOrganizationSubscription(
    tx: Prisma.TransactionClient,
    input: {
      organizationId: string;
      planId?: string;
      createdByUserId: string;
      requestedStatus?: SubscriptionStatus;
      requestedPaymentStatus?: SubscriptionPaymentStatus;
      requestedPaymentCollectionMethod?: PaymentCollectionMethod;
      notes?: string | null;
    },
  ) {
    const plan = await this.resolveSubscriptionPlan(tx, input.planId);
    if (!plan) {
      return null;
    }

    const billingSettings = await tx.billingSetting.findUnique({
      where: { id: 'global' },
    });

    const currentSubscription = await tx.organizationSubscription.findFirst({
      where: {
        organizationId: input.organizationId,
        isCurrent: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    const paymentCollectionMethod =
      plan.priceAmount.toNumber() === 0
        ? PaymentCollectionMethod.NONE
        : (input.requestedPaymentCollectionMethod ??
          billingSettings?.defaultPaymentCollectionMethod ??
          PaymentCollectionMethod.MANUAL);

    const paymentStatus =
      plan.priceAmount.toNumber() === 0
        ? SubscriptionPaymentStatus.NOT_REQUIRED
        : (input.requestedPaymentStatus ??
          (paymentCollectionMethod === PaymentCollectionMethod.NONE
            ? SubscriptionPaymentStatus.NOT_REQUIRED
            : SubscriptionPaymentStatus.PENDING));

    const status =
      plan.priceAmount.toNumber() === 0
        ? SubscriptionStatus.ACTIVE
        : (input.requestedStatus ??
          (paymentStatus === SubscriptionPaymentStatus.RECEIVED ||
          paymentStatus === SubscriptionPaymentStatus.WAIVED ||
          paymentStatus === SubscriptionPaymentStatus.NOT_REQUIRED ||
          billingSettings?.allowManualActivationWithoutPayment
            ? SubscriptionStatus.ACTIVE
            : SubscriptionStatus.PENDING_PAYMENT));

    const startsAt = status === SubscriptionStatus.ACTIVE ? new Date() : null;

    if (currentSubscription?.planId === plan.id) {
      return tx.organizationSubscription.update({
        where: { id: currentSubscription.id },
        data: {
          status,
          paymentStatus,
          paymentCollectionMethod,
          billingAmount: plan.priceAmount,
          billingCurrency: plan.currency,
          startsAt,
          renewsAt: this.calculateRenewalDate(startsAt, plan.billingCycle),
          graceEndsAt: this.calculateGraceEndDate(
            startsAt,
            billingSettings?.billingGraceDays ?? plan.graceDays ?? null,
          ),
          activatedAt: status === SubscriptionStatus.ACTIVE ? new Date() : null,
          notes: input.notes ?? currentSubscription.notes,
        },
      });
    }

    await tx.organizationSubscription.updateMany({
      where: {
        organizationId: input.organizationId,
        isCurrent: true,
      },
      data: {
        isCurrent: false,
        status: SubscriptionStatus.CANCELLED,
        endsAt: new Date(),
      },
    });

    return tx.organizationSubscription.create({
      data: {
        organizationId: input.organizationId,
        planId: plan.id,
        status,
        paymentStatus,
        paymentCollectionMethod,
        billingAmount: plan.priceAmount,
        billingCurrency: plan.currency,
        startsAt,
        renewsAt: this.calculateRenewalDate(startsAt, plan.billingCycle),
        graceEndsAt: this.calculateGraceEndDate(
          startsAt,
          billingSettings?.billingGraceDays ?? plan.graceDays ?? null,
        ),
        activatedAt: status === SubscriptionStatus.ACTIVE ? new Date() : null,
        isCurrent: true,
        notes: input.notes ?? null,
        createdByUserId: input.createdByUserId,
      },
    });
  }

  private async resolveSubscriptionPlan(
    tx: Prisma.TransactionClient,
    planId?: string,
  ) {
    if (planId) {
      const explicitPlan = await tx.subscriptionPlan.findFirst({
        where: {
          id: planId,
          status: PlanStatus.ACTIVE,
        },
      });

      if (!explicitPlan) {
        throw new BadRequestException('Selected subscription plan not found');
      }

      return explicitPlan;
    }

    const billingSettings = await tx.billingSetting.findUnique({
      where: { id: 'global' },
    });

    if (billingSettings?.defaultPlanId) {
      return tx.subscriptionPlan.findFirst({
        where: {
          id: billingSettings.defaultPlanId,
          status: PlanStatus.ACTIVE,
        },
      });
    }

    return tx.subscriptionPlan.findFirst({
      where: {
        isDefault: true,
        status: PlanStatus.ACTIVE,
      },
    });
  }

  private calculateRenewalDate(
    startsAt: Date | null,
    billingCycle: PlanBillingCycle,
  ) {
    if (!startsAt) {
      return null;
    }

    const renewsAt = new Date(startsAt);

    switch (billingCycle) {
      case 'QUARTERLY':
        renewsAt.setMonth(renewsAt.getMonth() + 3);
        return renewsAt;
      case 'YEARLY':
        renewsAt.setFullYear(renewsAt.getFullYear() + 1);
        return renewsAt;
      case 'ONE_TIME':
        return null;
      case 'CUSTOM':
        return null;
      default:
        renewsAt.setMonth(renewsAt.getMonth() + 1);
        return renewsAt;
    }
  }

  private calculateGraceEndDate(
    startsAt: Date | null,
    graceDays: number | null,
  ) {
    if (!startsAt || !graceDays) {
      return null;
    }

    return new Date(startsAt.getTime() + graceDays * 24 * 60 * 60 * 1000);
  }

  private async generateOrganizationClientCode(
    tx: Prisma.TransactionClient,
    referenceDate = new Date(),
  ) {
    const year = referenceDate.getUTCFullYear();
    const startOfYear = new Date(Date.UTC(year, 0, 1));
    const startOfNextYear = new Date(Date.UTC(year + 1, 0, 1));
    const organizations = await tx.organization.findMany({
      where: {
        createdAt: {
          gte: startOfYear,
          lt: startOfNextYear,
        },
      },
      select: { clientCode: true },
    });

    const nextSequence =
      organizations.reduce((highest, organization) => {
        const sequence = parsePlatformClientCodeSequence(
          organization.clientCode || '',
          year,
        );
        return sequence !== null && sequence > highest ? sequence : highest;
      }, -1) + 1;

    return formatPlatformClientCode(year, nextSequence);
  }

  private async generateIndependentDriverCode(tx: Prisma.TransactionClient) {
    const registrations = await tx.independentDriverRegistration.findMany({
      select: { driverCode: true },
    });
    const nextSequence =
      registrations.reduce((highest, registration) => {
        const sequence = parseIndependentDriverCodeSequence(
          registration.driverCode || '',
        );
        return sequence !== null && sequence > highest ? sequence : highest;
      }, -1) + 1;

    return formatIndependentDriverCode(nextSequence);
  }

  private async normalizeOrganizationClientCodes() {
    const organizations = await this.prisma.organization.findMany({
      orderBy: { createdAt: 'asc' },
      select: { id: true, clientCode: true, createdAt: true },
    });
    const usedSequences = new Map<number, Set<number>>();

    for (const organization of organizations) {
      const year = organization.createdAt.getUTCFullYear();
      const parsedSequence = parsePlatformClientCodeSequence(
        organization.clientCode || '',
        year,
      );

      if (parsedSequence !== null) {
        if (!usedSequences.has(year)) {
          usedSequences.set(year, new Set<number>());
        }
        usedSequences.get(year)?.add(parsedSequence);
      }
    }

    for (const organization of organizations) {
      const year = organization.createdAt.getUTCFullYear();
      const parsedSequence = parsePlatformClientCodeSequence(
        organization.clientCode || '',
        year,
      );

      if (parsedSequence !== null) {
        continue;
      }

      if (!usedSequences.has(year)) {
        usedSequences.set(year, new Set<number>());
      }

      const sequences = usedSequences.get(year)!;
      let nextSequence = 0;
      while (sequences.has(nextSequence)) {
        nextSequence += 1;
      }

      await this.prisma.organization.update({
        where: { id: organization.id },
        data: {
          clientCode: formatPlatformClientCode(year, nextSequence),
        },
      });
      sequences.add(nextSequence);
    }
  }

  private async normalizeIndependentDriverCodes() {
    if (this.independentDriverCodeColumnAvailable === false) {
      return;
    }

    let registrations: { id: string; driverCode: string | null }[];

    try {
      registrations = await this.prisma.independentDriverRegistration.findMany({
        orderBy: { createdAt: 'asc' },
        select: { id: true, driverCode: true },
      });
      this.independentDriverCodeColumnAvailable = true;
    } catch (error) {
      if (!this.isIndependentDriverCodeColumnMissing(error)) {
        throw error;
      }

      this.independentDriverCodeColumnAvailable = false;
      this.logger.warn(
        'Skipping independent driver code normalization because the driver_code column is not present in the current database.',
      );
      return;
    }
    const usedSequences = new Set<number>();

    for (const registration of registrations) {
      const parsedSequence = parseIndependentDriverCodeSequence(
        registration.driverCode || '',
      );

      if (parsedSequence !== null) {
        usedSequences.add(parsedSequence);
      }
    }

    for (const registration of registrations) {
      if (isIndependentDriverCode(registration.driverCode)) {
        continue;
      }

      let nextSequence = 0;
      while (usedSequences.has(nextSequence)) {
        nextSequence += 1;
      }

      await this.prisma.independentDriverRegistration.update({
        where: { id: registration.id },
        data: {
          driverCode: formatIndependentDriverCode(nextSequence),
        },
      });
      usedSequences.add(nextSequence);
    }
  }

  private async listIndependentDriversWithoutCodeColumn() {
    const registrations =
      await this.prisma.independentDriverRegistration.findMany({
        where: {
          status: IndependentDriverRegistrationStatus.PENDING_APPROVAL,
        },
        orderBy: { createdAt: 'asc' },
        select: this.independentDriverRegistrationLegacySelect(),
      });

    return registrations.map((registration) => ({
      ...registration,
      driverCode: null,
    }));
  }

  private async getIndependentDriverRegistrationWithoutCodeColumn(
    registrationId: string,
  ) {
    const registration =
      await this.prisma.independentDriverRegistration.findUnique({
        where: { id: registrationId },
        select: this.independentDriverRegistrationLegacySelect(),
      });

    if (!registration) {
      throw new BadRequestException(
        'Independent driver registration not found',
      );
    }

    return {
      ...registration,
      driverCode: null,
    };
  }

  private independentDriverRegistrationLegacySelect() {
    return {
      id: true,
      organizationId: true,
      fullName: true,
      phone: true,
      email: true,
      dateOfBirth: true,
      gender: true,
      addressLine1: true,
      addressLine2: true,
      city: true,
      state: true,
      postalCode: true,
      country: true,
      homeBaseLocation: true,
      licenseNumber: true,
      licenseExpiry: true,
      licenseType: true,
      licenseIssueDate: true,
      licenseIssuingState: true,
      aadhaarNumber: true,
      panNumber: true,
      vehicleNumber: true,
      vehicleType: true,
      vehicleModel: true,
      vehicleCapacity: true,
      vehicleOwnerName: true,
      vehicleRegistrationState: true,
      fuelType: true,
      uploadedDocuments: true,
      status: true,
      approvedAt: true,
      approvedByUserId: true,
      rejectedAt: true,
      rejectedReason: true,
      createdAt: true,
      updatedAt: true,
    } satisfies Prisma.IndependentDriverRegistrationSelect;
  }

  private isIndependentDriverCodeColumnMissing(error: unknown) {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2022' &&
      error.meta?.modelName === 'IndependentDriverRegistration'
    );
  }

  private async getUserForAuthentication(email: string) {
    return this.prisma.user.findUnique({
      where: {
        email: email.toLowerCase(),
      },
      include: {
        driverProfile: true,
        organizationMembers: {
          include: {
            organization: true,
          },
        },
      },
    });
  }

  private async assertValidPassword(
    user: {
      passwordHash: string | null;
    } | null,
    password: string,
    email: string,
  ) {
    const lockKey = email.trim().toLowerCase();
    const lockedForMs = loginAttemptLimiter.lockedFor(lockKey);
    if (lockedForMs > 0) {
      throw new HttpException(
        `Too many failed sign-in attempts. Try again in ${Math.ceil(lockedForMs / 60_000)} minute(s).`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // Always run bcrypt so response time does not reveal whether the account exists.
    const passwordMatches = await compare(
      password,
      user?.passwordHash ?? DUMMY_PASSWORD_HASH,
    );

    if (!user?.passwordHash || !passwordMatches) {
      loginAttemptLimiter.recordFailure(lockKey);
      throw new UnauthorizedException('Invalid email or password');
    }

    loginAttemptLimiter.reset(lockKey);
  }

  private async completeLogin(user: {
    id: string;
    fullName: string;
    email: string;
    passwordHash: string | null;
    status: UserStatus;
    platformRole: PlatformRole | null;
    driverProfile?: {
      id: string;
      organizationId: string;
      driverCode: string;
      fullName: string;
      phone: string;
      email: string | null;
      status: import('@prisma/client').DriverStatus;
      employmentType: import('@prisma/client').EmploymentType;
      homeBase: string | null;
      licenseNumber: string | null;
      licenseExpiry: Date | null;
    } | null;
    organizationMembers: {
      organizationId: string;
      role: OrganizationRole;
      status: MembershipStatus;
      sectionAccess: Prisma.JsonValue | null;
      organization: {
        name: string;
        status: OrganizationStatus;
      };
    }[];
  }) {
    const activeMemberships = user.organizationMembers.filter(
      (membership) =>
        membership.status === MembershipStatus.ACTIVE &&
        (membership.organization.status === OrganizationStatus.ACTIVE ||
          membership.organization.status ===
            OrganizationStatus.PENDING_APPROVAL),
    );

    // Roles/memberships in the token are informational only: JwtStrategy
    // reloads them from the database on every request.
    const payload: JwtPayload = {
      typ: ACCESS_TOKEN_TYPE,
      pwv: passwordFingerprint(
        user.passwordHash,
        jwtSecret(this.configService),
      ),
      sub: user.id,
      email: user.email,
      platformRole: user.platformRole ?? null,
      membershipRoles: activeMemberships.map((membership) => membership.role),
      organizationIds: activeMemberships.map(
        (membership) => membership.organizationId,
      ),
      memberships: activeMemberships.map((membership) => ({
        organizationId: membership.organizationId,
        role: membership.role,
        sectionAccess: membership.sectionAccess,
      })),
    };

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    return {
      accessToken: await this.jwtService.signAsync(payload),
      user: {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        platformRole: user.platformRole,
        status: user.status,
        driverProfile: user.driverProfile
          ? {
              id: user.driverProfile.id,
              organizationId: user.driverProfile.organizationId,
              driverCode: user.driverProfile.driverCode,
              fullName: user.driverProfile.fullName,
              phone: user.driverProfile.phone,
              email: user.driverProfile.email,
              status: user.driverProfile.status,
              employmentType: user.driverProfile.employmentType,
              homeBase: user.driverProfile.homeBase,
              licenseNumber: user.driverProfile.licenseNumber,
              licenseExpiry: user.driverProfile.licenseExpiry,
            }
          : null,
        organizationMemberships: activeMemberships.map((membership) => ({
          organizationId: membership.organizationId,
          organizationName: membership.organization.name,
          organizationStatus: membership.organization.status,
          role: membership.role,
          membershipStatus: membership.status,
          sectionAccess: membership.sectionAccess,
        })),
      },
    };
  }

  private async clearLoginOtp(userId: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        loginOtpHash: null,
        loginOtpExpiresAt: null,
        loginOtpRequestedAt: null,
      },
    });
  }

  private shouldExposeEmailTokens() {
    // Defaults to false and is always false when NODE_ENV=production.
    return shouldExposeEmailTokens(
      this.configService.get<string>('AUTH_EXPOSE_EMAIL_TOKENS'),
    );
  }

  private validateIndependentDriverRegistration(
    input: RegisterIndependentDriverDto,
  ) {
    if (!input.aadhaarNumber && !input.panNumber) {
      throw new BadRequestException(
        'At least one of aadhaarNumber or panNumber must be provided',
      );
    }

    const documentTypes = new Set(
      input.uploadedDocuments.map((document) => document.documentType),
    );

    if (!documentTypes.has('RC_DOCUMENT')) {
      throw new BadRequestException('RC_DOCUMENT upload is required');
    }

    if (!documentTypes.has('DRIVING_LICENSE_PHOTO')) {
      throw new BadRequestException('DRIVING_LICENSE_PHOTO upload is required');
    }

    if (!documentTypes.has('AADHAAR_CARD') && !documentTypes.has('PAN_CARD')) {
      throw new BadRequestException(
        'At least one of AADHAAR_CARD or PAN_CARD upload is required',
      );
    }
  }
}
