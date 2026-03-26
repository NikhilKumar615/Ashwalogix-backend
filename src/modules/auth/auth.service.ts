import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  DocumentEntityType,
  DocumentStatus,
  IndependentDriverRegistrationStatus,
  Prisma,
  MembershipStatus,
  OrganizationRole,
  OrganizationStatus,
  PlatformRole,
  UserStatus,
} from '@prisma/client';
import { compare, hash } from 'bcryptjs';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { LoginDto } from './dto/login.dto';
import { RegisterCompanyAdminDto } from './dto/register-company-admin.dto';
import { RegisterIndependentDriverDto } from './dto/register-independent-driver.dto';
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
    const user = await this.prisma.user.findUnique({
      where: {
        email: input.email.toLowerCase(),
      },
      include: {
        organizationMembers: {
          include: {
            organization: true,
          },
        },
      },
    });

    if (!user?.passwordHash) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const passwordMatches = await compare(input.password, user.passwordHash);

    if (!passwordMatches) {
      throw new UnauthorizedException('Invalid email or password');
    }

    this.assertUserCanLogin(user);

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
            organization: true,
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
      })),
    };
  }

  async getPendingOrganizations() {
    return this.prisma.organization.findMany({
      where: {
        status: OrganizationStatus.PENDING_APPROVAL,
      },
      orderBy: { createdAt: 'asc' },
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
          status: OrganizationStatus.ACTIVE,
          approvedAt,
          approvedByUserId: approverUserId,
          rejectedAt: null,
          rejectedReason: null,
        },
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







