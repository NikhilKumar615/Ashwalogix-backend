import {
  BadRequestException,
  ForbiddenException,
  Injectable,
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
import { compare, hash } from 'bcryptjs';
import { randomInt, randomUUID } from 'crypto';
import { PrismaService } from '../../shared/prisma/prisma.service';
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

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly mailService: MailService,
  ) {}

  async registerCompanyAdmin(input: RegisterCompanyAdminDto) {
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

    const verificationToken = randomUUID();
    const verificationHours = Number(
      this.configService.get<string>('EMAIL_VERIFICATION_TTL_HOURS') ?? '24',
    );
    const verificationTokenExpiresAt = new Date(
      Date.now() + verificationHours * 60 * 60 * 1000,
    );
    const passwordHash = await hash(input.password, 10);

    const result = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          fullName: input.fullName,
          email: input.email.toLowerCase(),
          phone: input.phone,
          passwordHash,
          status: UserStatus.PENDING_VERIFICATION,
          verificationToken,
          verificationTokenExpiresAt,
        },
      });

      const organization = await tx.organization.create({
        data: {
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

    await this.mailService.sendVerificationEmail({
      to: result.user.email,
      fullName: result.user.fullName,
      token: verificationToken,
    });

    return {
      message:
        'Registration created. Verify the email first, then wait for SUPER_ADMIN approval.',
      userId: result.user.id,
      organizationId: result.organization.id,
      verificationToken: this.shouldExposeEmailTokens() ? verificationToken : undefined,
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

    return this.prisma.independentDriverRegistration.create({
      data: {
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
        status: 'PENDING_APPROVAL',
      },
    });
  }

  async verifyEmail(input: VerifyEmailDto) {
    const user = await this.prisma.user.findFirst({
      where: {
        verificationToken: input.token,
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

    const updatedUser = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerifiedAt: new Date(),
        verificationToken: null,
        verificationTokenExpiresAt: null,
        status: UserStatus.PENDING_APPROVAL,
      },
    });

    return {
      message:
        'Email verified successfully. Your account is now waiting for SUPER_ADMIN approval.',
      userId: updatedUser.id,
      status: updatedUser.status,
    };
  }

  async login(input: LoginDto) {
    const user = await this.getUserForAuthentication(input.email);

    await this.assertValidPassword(user, input.password);
    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }

    this.assertUserCanLogin(user);

    if (user.platformRole === PlatformRole.SUPER_ADMIN) {
      throw new ForbiddenException(
        'SUPER_ADMIN accounts must complete OTP verification to sign in',
      );
    }

    return this.completeLogin(user);
  }

  async requestSuperAdminOtp(input: SuperAdminRequestOtpDto) {
    const user = await this.getUserForAuthentication(input.email);

    await this.assertValidPassword(user, input.password);
    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }
    this.assertUserCanLogin(user);

    if (user.platformRole !== PlatformRole.SUPER_ADMIN) {
      throw new ForbiddenException(
        'Only SUPER_ADMIN accounts can use the OTP sign-in flow',
      );
    }

    const otp = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const ttlMinutes = Number(
      this.configService.get<string>('SUPER_ADMIN_LOGIN_OTP_TTL_MINUTES') ??
        '10',
    );
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMinutes * 60 * 1000);

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

    return {
      message: 'OTP sent to your email address',
      email: user.email,
      expiresAt,
      otp: this.shouldExposeEmailTokens() ? otp : undefined,
    };
  }

  async verifySuperAdminOtp(input: SuperAdminVerifyOtpDto) {
    const user = await this.getUserForAuthentication(input.email);
    if (!user) {
      throw new UnauthorizedException('Invalid email or OTP');
    }

    this.assertUserCanLogin(user);

    if (user.platformRole !== PlatformRole.SUPER_ADMIN) {
      throw new ForbiddenException(
        'Only SUPER_ADMIN accounts can use the OTP sign-in flow',
      );
    }

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
      throw new UnauthorizedException('Invalid OTP');
    }

    await this.clearLoginOtp(user.id);

    return this.completeLogin(user);
  }

  async forgotPassword(email: string) {
    const user = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    });

    if (!user) {
      return {
        message:
          'If an account exists for this email, a reset token has been generated.',
      };
    }

    const resetPasswordToken = randomUUID();
    const resetHours = Number(
      this.configService.get<string>('PASSWORD_RESET_TTL_HOURS') ?? '1',
    );
    const resetPasswordTokenExpiresAt = new Date(
      Date.now() + resetHours * 60 * 60 * 1000,
    );

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        resetPasswordToken,
        resetPasswordTokenExpiresAt,
      },
    });

    await this.mailService.sendPasswordResetEmail({
      to: user.email,
      fullName: user.fullName,
      token: resetPasswordToken,
    });

    return {
      message:
        'Password reset token created. Check your email for the reset link.',
      resetToken: this.shouldExposeEmailTokens() ? resetPasswordToken : undefined,
      expiresAt: this.shouldExposeEmailTokens() ? resetPasswordTokenExpiresAt : undefined,
    };
  }

  async resetPassword(token: string, newPassword: string) {
    const user = await this.prisma.user.findFirst({
      where: { resetPasswordToken: token },
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
      },
    });

    return {
      message: 'Password reset successful. You can now log in with the new password.',
      userId: user.id,
    };
  }

  async getCurrentUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
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
      approvedAt: user.approvedAt,
      organizationMemberships: user.organizationMembers.map((membership) => ({
        organizationId: membership.organizationId,
        organizationName: membership.organization.name,
        organizationStatus: membership.organization.status,
        role: membership.role,
        membershipStatus: membership.status,
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
          clientCode: this.generateClientCode(input.organizationName),
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
          addressLine1: input.branches?.[0]?.addressLine1 ?? organization.addressLine1,
          addressLine2: input.branches?.[0]?.addressLine2 ?? organization.addressLine2,
          city: input.branches?.[0]?.city ?? organization.city,
          state: input.branches?.[0]?.state ?? organization.state,
          postalCode: input.branches?.[0]?.postalCode ?? organization.postalCode,
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
    return this.prisma.independentDriverRegistration.findMany({
      where: {
        status: IndependentDriverRegistrationStatus.PENDING_APPROVAL,
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async getIndependentDriverRegistration(registrationId: string) {
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
      throw new ForbiddenException('Only SUPER_ADMIN can approve organizations');
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
          clientCode: organization.clientCode ?? this.generateClientCode(organization.name),
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

    await this.mailService.sendOrganizationApprovedEmail({
      to: ownerUser.email,
      fullName: ownerUser.fullName,
      organizationName: organization.name,
      notes: notes ?? null,
    });

    return {
      message: 'Organization approved successfully',
      organizationId,
      approvedAt,
      notes: notes ?? null,
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

    if (ownerUser?.email) {
      await this.mailService.sendOrganizationRejectedEmail({
        to: ownerUser.email,
        fullName: ownerUser.fullName,
        organizationName: organization.name,
        reason,
      });
    }

    return {
      message: 'Organization rejected successfully',
      organizationId,
      rejectedAt,
      reason,
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

    if (registration.email) {
      await this.mailService.sendIndependentDriverApprovedEmail({
        to: registration.email,
        fullName: registration.fullName,
        notes: notes ?? null,
      });
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

    if (registration.email) {
      await this.mailService.sendIndependentDriverRejectedEmail({
        to: registration.email,
        fullName: registration.fullName,
        reason,
      });
    }

    return {
      message: 'Independent driver registration rejected successfully',
      registrationId,
      rejectedAt,
      reason,
    };
  }

  private assertUserCanLogin(user: {
    status: UserStatus;
    emailVerifiedAt: Date | null;
    platformRole: PlatformRole | null;
    organizationMembers: {
      organization: { status: OrganizationStatus };
      status: MembershipStatus;
    }[];
  }) {
    if (!user.emailVerifiedAt) {
      throw new ForbiddenException(
        'Verify your email before attempting to log in',
      );
    }

    if (user.status === UserStatus.PENDING_VERIFICATION) {
      throw new ForbiddenException('Email verification is still pending');
    }

    if (user.status === UserStatus.PENDING_APPROVAL) {
      throw new ForbiddenException(
        'Your account is waiting for SUPER_ADMIN approval',
      );
    }

    if (user.status === UserStatus.REJECTED) {
      throw new ForbiddenException('Your account has been rejected');
    }

    if (user.status === UserStatus.SUSPENDED) {
      throw new ForbiddenException('Your account is suspended');
    }

    if (user.platformRole === PlatformRole.SUPER_ADMIN) {
      return;
    }

    const hasActiveOrgMembership = user.organizationMembers.some(
      (membership) =>
        membership.status === MembershipStatus.ACTIVE &&
        membership.organization.status === OrganizationStatus.ACTIVE,
    );

    if (!hasActiveOrgMembership) {
      throw new ForbiddenException(
        'No active organization access is available for this account',
      );
    }
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
        : input.requestedPaymentCollectionMethod ??
          billingSettings?.defaultPaymentCollectionMethod ??
          PaymentCollectionMethod.MANUAL;

    const paymentStatus =
      plan.priceAmount.toNumber() === 0
        ? SubscriptionPaymentStatus.NOT_REQUIRED
        : input.requestedPaymentStatus ??
          (paymentCollectionMethod === PaymentCollectionMethod.NONE
        ? SubscriptionPaymentStatus.NOT_REQUIRED
        : SubscriptionPaymentStatus.PENDING);

    const status =
      plan.priceAmount.toNumber() === 0
        ? SubscriptionStatus.ACTIVE
        : input.requestedStatus ??
          (paymentStatus === SubscriptionPaymentStatus.RECEIVED ||
          paymentStatus === SubscriptionPaymentStatus.WAIVED ||
          paymentStatus === SubscriptionPaymentStatus.NOT_REQUIRED ||
          billingSettings?.allowManualActivationWithoutPayment
            ? SubscriptionStatus.ACTIVE
            : SubscriptionStatus.PENDING_PAYMENT);

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

  private calculateGraceEndDate(startsAt: Date | null, graceDays: number | null) {
    if (!startsAt || !graceDays) {
      return null;
    }

    return new Date(startsAt.getTime() + graceDays * 24 * 60 * 60 * 1000);
  }

  private generateClientCode(name: string) {
    const prefix = name
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '')
      .slice(0, 2);

    return `LW-${prefix || 'CL'}${Date.now().toString().slice(-4)}`;
  }

  private async getUserForAuthentication(email: string) {
    return this.prisma.user.findUnique({
      where: {
        email: email.toLowerCase(),
      },
      include: {
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
  ) {
    if (!user?.passwordHash) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const passwordMatches = await compare(password, user.passwordHash);

    if (!passwordMatches) {
      throw new UnauthorizedException('Invalid email or password');
    }
  }

  private async completeLogin(user: {
    id: string;
    fullName: string;
    email: string;
    status: UserStatus;
    platformRole: PlatformRole | null;
    organizationMembers: {
      organizationId: string;
      role: OrganizationRole;
      status: MembershipStatus;
      organization: {
        name: string;
        status: OrganizationStatus;
      };
    }[];
  }) {
    const activeMemberships = user.organizationMembers.filter(
      (membership) =>
        membership.status === MembershipStatus.ACTIVE &&
        membership.organization.status === OrganizationStatus.ACTIVE,
    );

    const payload: JwtPayload = {
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
        organizationMemberships: activeMemberships.map((membership) => ({
          organizationId: membership.organizationId,
          organizationName: membership.organization.name,
          role: membership.role,
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
    return (
      String(
        this.configService.get<string>('AUTH_EXPOSE_EMAIL_TOKENS') ?? 'true',
      ).toLowerCase() === 'true'
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

    if (
      !documentTypes.has('AADHAAR_CARD') &&
      !documentTypes.has('PAN_CARD')
    ) {
      throw new BadRequestException(
        'At least one of AADHAAR_CARD or PAN_CARD upload is required',
      );
    }
  }
}







