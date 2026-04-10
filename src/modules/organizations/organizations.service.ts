import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DriverStatus,
  EmploymentType,
  MembershipStatus,
  OrganizationRole,
  OrganizationStatus,
  Prisma,
  UserStatus,
} from '@prisma/client';
import { hash } from 'bcryptjs';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../shared/prisma/prisma.service';
import {
  buildBusinessPrefix,
  buildStatePrefix,
  formatRollingAlphaCodeWithState,
  parseRollingAlphaCodeSequence,
} from '../../shared/codes/entity-code.util';
import { MailService } from '../mail/mail.service';
import { CreateOrganizationUserDto } from './dto/create-organization-user.dto';
import { RegisterCompanyDriverDto } from './dto/register-company-driver.dto';
import { RegisterDispatcherDto } from './dto/register-dispatcher.dto';
import { RegisterOrganizationStaffDto } from './dto/register-organization-staff.dto';
import { UpdateOrganizationUserDto } from './dto/update-organization-user.dto';

@Injectable()
export class OrganizationsService {
  private readonly logger = new Logger(OrganizationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly mailService: MailService,
  ) {}

  async listUsers(organizationId: string) {
    await this.ensureOrganizationIsActive(organizationId);

    return this.prisma.organizationUser.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'asc' },
      include: {
        user: {
          include: {
            driverProfile: true,
          },
        },
      },
    });
  }

  async getUserById(organizationId: string, userId: string) {
    await this.ensureOrganizationIsActive(organizationId);

    const organizationUser = await this.prisma.organizationUser.findFirst({
      where: {
        organizationId,
        userId,
      },
      include: {
        user: {
          include: {
            driverProfile: true,
          },
        },
      },
    });

    if (!organizationUser) {
      throw new NotFoundException('Organization user not found');
    }

    return organizationUser;
  }

  async createOrganizationUser(
    organizationId: string,
    input: CreateOrganizationUserDto,
    createdByUserId: string,
  ) {
    const organization = await this.ensureOrganizationIsActive(organizationId);

    return this.createUserWithinOrganization(
      organization,
      input,
      createdByUserId,
    );
  }

  async registerDispatcher(
    organizationId: string,
    input: RegisterDispatcherDto,
    createdByUserId: string,
  ) {
    const organization = await this.ensureOrganizationIsActive(organizationId);

    return this.createUserWithinOrganization(
      organization,
      {
        fullName: input.fullName,
        email: input.email,
        phone: input.phone,
        password: input.password,
        role: OrganizationRole.DISPATCHER,
      },
      createdByUserId,
    );
  }

  async registerWarehouseStaff(
    organizationId: string,
    input: RegisterOrganizationStaffDto,
    createdByUserId: string,
  ) {
    const organization = await this.ensureOrganizationIsActive(organizationId);

    return this.createUserWithinOrganization(
      organization,
      {
        fullName: input.fullName,
        email: input.email,
        phone: input.phone,
        password: input.password,
        role: OrganizationRole.WAREHOUSE,
      },
      createdByUserId,
    );
  }

  async registerOperationsStaff(
    organizationId: string,
    input: RegisterOrganizationStaffDto,
    createdByUserId: string,
  ) {
    const organization = await this.ensureOrganizationIsActive(organizationId);

    return this.createUserWithinOrganization(
      organization,
      {
        fullName: input.fullName,
        email: input.email,
        phone: input.phone,
        password: input.password,
        role: OrganizationRole.OPERATIONS,
      },
      createdByUserId,
    );
  }

  async registerCompanyDriver(
    organizationId: string,
    input: RegisterCompanyDriverDto,
    createdByUserId: string,
  ) {
    const organization = await this.ensureOrganizationIsActive(organizationId);

    return this.createUserWithinOrganization(
      organization,
      {
        fullName: input.fullName,
        email: input.email,
        phone: input.phone,
        password: input.password,
        role: OrganizationRole.DRIVER,
        employmentType: input.employmentType,
        licenseNumber: input.licenseNumber,
        driverCode: input.driverCode,
        homeBase: input.homeBase,
      },
      createdByUserId,
    );
  }

  async updateOrganizationUser(
    organizationId: string,
    userId: string,
    input: UpdateOrganizationUserDto,
  ) {
    await this.ensureOrganizationIsActive(organizationId);

    const organizationUser = await this.prisma.organizationUser.findFirst({
      where: {
        organizationId,
        userId,
      },
      include: {
        user: true,
      },
    });

    if (!organizationUser) {
      throw new NotFoundException('Organization user not found');
    }

    if (input.email || input.phone) {
      await this.ensureUserIdentityIsAvailable(
        userId,
        input.email,
        input.phone,
      );
    }

    const passwordHash = input.password ? await hash(input.password, 10) : undefined;

    return this.prisma.$transaction(async (tx) => {
      const updatedUser = await tx.user.update({
        where: { id: userId },
        data: {
          fullName: input.fullName,
          email: input.email?.toLowerCase(),
          phone: input.phone,
          passwordHash,
          status: input.userStatus,
        },
        include: {
          driverProfile: true,
        },
      });

      const updatedMembership = await tx.organizationUser.update({
        where: {
          organizationId_userId: {
            organizationId,
            userId,
          },
        },
        data: {
          status: input.membershipStatus,
        },
      });

      if (updatedUser.driverProfile) {
        await tx.driver.update({
          where: { id: updatedUser.driverProfile.id },
          data: {
            fullName: input.fullName,
            email: input.email?.toLowerCase(),
            phone: input.phone,
            status:
              input.userStatus === UserStatus.SUSPENDED
                ? DriverStatus.SUSPENDED
                : updatedUser.driverProfile.status,
          },
        });
      }

      return {
        ...updatedMembership,
        user: updatedUser,
      };
    });
  }

  private async createUserWithinOrganization(
    organization: { id: string; name: string; state: string | null },
    input: CreateOrganizationUserDto,
    createdByUserId: string,
  ) {
    if (input.role === OrganizationRole.ORG_ADMIN) {
      throw new BadRequestException(
        'Use the company onboarding flow for the first org admin. This endpoint is intended for company-managed staff accounts.',
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

    const now = new Date();
    const temporaryPassword = input.password || this.generateTemporaryPassword();
    const passwordHash = await hash(temporaryPassword, 10);
    const resetPasswordToken = randomUUID();
    const resetHours = Number(
      this.configService.get<string>('PASSWORD_RESET_TTL_HOURS') ?? '24',
    );
    const resetPasswordTokenExpiresAt = new Date(
      Date.now() + resetHours * 60 * 60 * 1000,
    );

    const createdUser = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          fullName: input.fullName,
          email: input.email.toLowerCase(),
          phone: input.phone,
          passwordHash,
          status: UserStatus.ACTIVE,
          emailVerifiedAt: now,
          approvedAt: now,
          approvedByUserId: createdByUserId,
          resetPasswordToken,
          resetPasswordTokenExpiresAt,
        },
      });

      await tx.organizationUser.create({
        data: {
          organizationId: organization.id,
          userId: user.id,
          role: input.role,
          status: MembershipStatus.ACTIVE,
        },
      });

      if (input.role === OrganizationRole.DRIVER) {
        await tx.driver.create({
          data: {
            organizationId: organization.id,
            userId: user.id,
            driverCode: await this.generateDriverCode(
              tx,
              organization.id,
              organization.name,
              organization.state,
            ),
            fullName: input.fullName,
            phone: input.phone ?? input.email,
            email: input.email.toLowerCase(),
            employmentType: input.employmentType ?? EmploymentType.EMPLOYEE,
            licenseNumber: input.licenseNumber,
            homeBase: input.homeBase,
          },
        });
      }

      return tx.user.findUnique({
        where: { id: user.id },
        include: {
          organizationMembers: true,
          driverProfile: true,
        },
      });
    });

    if (!createdUser) {
      throw new BadRequestException('Organization user could not be created');
    }

    if (input.role !== OrganizationRole.DRIVER) {
      try {
        await this.mailService.sendOrganizationUserInvitationEmail({
          to: createdUser.email,
          fullName: createdUser.fullName,
          organizationName: organization.name,
          roleLabel: this.formatRoleLabel(input.role),
          token: resetPasswordToken,
        });
      } catch (error) {
        this.logger.error(
          `Organization user ${createdUser.id} was created but invitation email could not be sent.`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }

    return {
      ...createdUser,
      temporaryPassword:
        input.role === OrganizationRole.DRIVER ? temporaryPassword : undefined,
    };
  }

  private async ensureUserIdentityIsAvailable(
    currentUserId: string,
    email?: string,
    phone?: string,
  ) {
    const identityConflicts = await this.prisma.user.findFirst({
      where: {
        id: {
          not: currentUserId,
        },
        OR: [
          ...(email ? [{ email: email.toLowerCase() }] : []),
          ...(phone ? [{ phone }] : []),
        ],
      },
    });

    if (identityConflicts) {
      throw new BadRequestException(
        'A different user already exists with this email or phone',
      );
    }
  }

  private async ensureOrganizationIsActive(organizationId: string) {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
    });

    if (!organization) {
      throw new NotFoundException('Organization not found');
    }

    if (organization.status !== OrganizationStatus.ACTIVE) {
      throw new BadRequestException(
        'Users can only be managed for active organizations',
      );
    }

    return organization;
  }

  private async generateDriverCode(
    tx: Prisma.TransactionClient,
    organizationId: string,
    organizationName: string,
    organizationState: string | null,
  ) {
    const prefix = buildBusinessPrefix(organizationName);
    const statePrefix = buildStatePrefix(organizationState);
    const existingCodes = await tx.driver.findMany({
      where: { organizationId },
      select: { driverCode: true },
    });
    const nextSequence =
      existingCodes.reduce((highest, driver) => {
        const sequence = parseRollingAlphaCodeSequence(
          driver.driverCode,
          prefix,
          'DRV',
          statePrefix,
        );
        return sequence !== null && sequence > highest ? sequence : highest;
      }, -1) + 1;

    return formatRollingAlphaCodeWithState(
      prefix,
      'DRV',
      statePrefix,
      nextSequence,
    );
  }

  private formatRoleLabel(role: OrganizationRole) {
    return role
      .split('_')
      .map((segment) => segment.charAt(0) + segment.slice(1).toLowerCase())
      .join(' ');
  }

  private generateTemporaryPassword() {
    return `Lg${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  }
}
