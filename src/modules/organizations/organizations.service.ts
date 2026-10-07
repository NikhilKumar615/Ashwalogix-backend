import {
  BadRequestException,
  ForbiddenException,
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
import { compare, hash } from 'bcryptjs';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../shared/prisma/prisma.service';
import {
  SAFE_USER_WITH_DRIVER_SELECT,
  generateOneTimeToken,
  hashOneTimeToken,
  invalidateUserSession,
  type SectionAccessValue,
} from '../auth/auth-security.util';
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
import { SectionAccessDto } from './dto/section-access.dto';
import { UpdateOrganizationUserDto } from './dto/update-organization-user.dto';

const PORTAL_SECTION_KEYS = [
  'dashboard',
  'clients',
  'shipments',
  'warehouses',
  'drivers',
  'vehicles',
  'users',
  'documents',
  'track',
  'account',
];

/**
 * Who is performing a user-management action. `isOrgAdmin` must come from the
 * caller's ORG_ADMIN role (or SUPER_ADMIN) — never from section access.
 */
export type OrganizationActor = {
  userId: string;
  isOrgAdmin: boolean;
  sectionAccess: SectionAccessValue | null;
};

/** Public directory fields returned by the client-code lookup (no internal notes/ownership). */
const ORGANIZATION_LOOKUP_SELECT = {
  id: true,
  name: true,
  clientCode: true,
  legalName: true,
  companyType: true,
  industry: true,
  billingCycle: true,
  creditAccount: true,
  contactPerson: true,
  designation: true,
  contactEmail: true,
  contactPhone: true,
  email: true,
  phone: true,
  gstNumber: true,
  panNumber: true,
  addressLine1: true,
  addressLine2: true,
  city: true,
  state: true,
  postalCode: true,
  country: true,
  status: true,
  locations: {
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
  },
} satisfies Prisma.OrganizationSelect;

@Injectable()
export class OrganizationsService {
  private readonly logger = new Logger(OrganizationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly mailService: MailService,
  ) {}

  async listUsers(organizationId: string) {
    await this.ensureOrganizationExists(organizationId);

    return this.prisma.organizationUser.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'asc' },
      include: {
        user: {
          select: SAFE_USER_WITH_DRIVER_SELECT,
        },
      },
    });
  }

  async getUserById(organizationId: string, userId: string) {
    await this.ensureOrganizationExists(organizationId);

    const organizationUser = await this.prisma.organizationUser.findFirst({
      where: {
        organizationId,
        userId,
      },
      include: {
        user: {
          select: SAFE_USER_WITH_DRIVER_SELECT,
        },
      },
    });

    if (!organizationUser) {
      throw new NotFoundException('Organization user not found');
    }

    return organizationUser;
  }

  async lookupOrganizationByClientCode(clientCode: string) {
    const normalizedCode = clientCode.trim().toUpperCase();

    const organization = await this.prisma.organization.findFirst({
      where: {
        clientCode: normalizedCode,
        status: OrganizationStatus.ACTIVE,
      },
      select: ORGANIZATION_LOOKUP_SELECT,
    });

    if (!organization) {
      throw new NotFoundException('Organization not found');
    }

    return organization;
  }

  async createOrganizationUser(
    organizationId: string,
    input: CreateOrganizationUserDto,
    actor: OrganizationActor,
  ) {
    const organization = await this.ensureOrganizationIsActive(organizationId);

    return this.createUserWithinOrganization(organization, input, actor);
  }

  async registerDispatcher(
    organizationId: string,
    input: RegisterDispatcherDto,
    actor: OrganizationActor,
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
        sectionAccess: input.sectionAccess,
      },
      actor,
    );
  }

  async registerWarehouseStaff(
    organizationId: string,
    input: RegisterOrganizationStaffDto,
    actor: OrganizationActor,
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
        sectionAccess: input.sectionAccess,
      },
      actor,
    );
  }

  async registerOperationsStaff(
    organizationId: string,
    input: RegisterOrganizationStaffDto,
    actor: OrganizationActor,
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
        sectionAccess: input.sectionAccess,
      },
      actor,
    );
  }

  async registerCompanyDriver(
    organizationId: string,
    input: RegisterCompanyDriverDto,
    actor: OrganizationActor,
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
        sectionAccess: input.sectionAccess,
      },
      actor,
    );
  }

  async updateOrganizationUser(
    organizationId: string,
    userId: string,
    input: UpdateOrganizationUserDto,
    actor: OrganizationActor,
  ) {
    await this.ensureOrganizationIsActive(organizationId);

    const organizationUser = await this.prisma.organizationUser.findFirst({
      where: {
        organizationId,
        userId,
      },
      include: {
        user: {
          select: { id: true, email: true, passwordHash: true },
        },
      },
    });

    if (!organizationUser) {
      throw new NotFoundException('Organization user not found');
    }

    const isSelf = actor.userId === userId;
    const changesPermissions =
      input.sectionAccess !== undefined ||
      input.membershipStatus !== undefined ||
      input.userStatus !== undefined;

    if (isSelf && changesPermissions) {
      throw new ForbiddenException(
        'You cannot change your own access, membership status or account status',
      );
    }

    if (!isSelf && !actor.isOrgAdmin) {
      if (organizationUser.role === OrganizationRole.ORG_ADMIN) {
        throw new ForbiddenException(
          'Only an organization admin can modify an organization admin',
        );
      }
      if (input.password) {
        throw new ForbiddenException(
          "Only an organization admin can set another user's password",
        );
      }
      if (input.email) {
        throw new ForbiddenException(
          "Only an organization admin can change another user's email",
        );
      }
      if (input.sectionAccess !== undefined) {
        this.assertCanGrantSectionAccess(actor, input.sectionAccess);
      }
    }

    // Changing your own password through this endpoint requires the current
    // password (prefer POST /auth/change-password).
    if (isSelf && input.password) {
      if (
        !input.currentPassword ||
        !organizationUser.user.passwordHash ||
        !(await compare(
          input.currentPassword,
          organizationUser.user.passwordHash,
        ))
      ) {
        throw new BadRequestException(
          'Current password is required and must be correct. Use POST /auth/change-password.',
        );
      }
    }

    if (input.email || input.phone) {
      await this.ensureUserIdentityIsAvailable(
        userId,
        input.email,
        input.phone,
      );
    }

    const passwordHash = input.password
      ? await hash(input.password, 10)
      : undefined;

    const result = await this.prisma.$transaction(async (tx) => {
      const updatedUser = await tx.user.update({
        where: { id: userId },
        data: {
          fullName: input.fullName,
          email: input.email?.toLowerCase(),
          phone: input.phone,
          passwordHash,
          ...(passwordHash
            ? { resetPasswordToken: null, resetPasswordTokenExpiresAt: null }
            : {}),
          status: input.userStatus,
        },
        select: SAFE_USER_WITH_DRIVER_SELECT,
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
          sectionAccess:
            input.sectionAccess === undefined
              ? undefined
              : this.normalizeSectionAccess(
                  organizationUser.role,
                  input.sectionAccess,
                ),
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

    // Permission/password/status changes take effect on the next request.
    invalidateUserSession(userId);
    return result;
  }

  /**
   * Non-admin managers (e.g. OPERATIONS with the "users" section) may only
   * grant sections they hold themselves, and never fullAccess.
   */
  private assertCanGrantSectionAccess(
    actor: OrganizationActor,
    requested?: SectionAccessDto,
  ) {
    if (actor.isOrgAdmin || !requested) {
      return;
    }

    if (requested.fullAccess) {
      throw new ForbiddenException(
        'Only an organization admin can grant full access',
      );
    }

    const held = actor.sectionAccess;
    const requestedSections = (requested.sections ?? []).map((section) =>
      section.trim().toLowerCase(),
    );
    const allowed =
      held?.fullAccess === true
        ? requestedSections
        : requestedSections.filter((section) =>
            held?.sections.includes(section),
          );

    if (allowed.length !== requestedSections.length) {
      throw new ForbiddenException(
        'You can only grant portal sections that you have access to',
      );
    }
  }

  async deleteOrganizationUser(
    organizationId: string,
    userId: string,
    reason: string,
    deletedByUserId: string,
    actorIsOrgAdmin = false,
  ) {
    if (userId === deletedByUserId) {
      throw new BadRequestException(
        'You cannot remove your own account. Transfer administration first.',
      );
    }
    const organization = await this.ensureOrganizationIsActive(organizationId);
    if (organization.ownerUserId === userId) {
      throw new BadRequestException(
        'The organization owner cannot be removed. Transfer ownership first.',
      );
    }
    const membership = await this.prisma.organizationUser.findFirst({
      where: { organizationId, userId },
      include: { user: { select: { id: true, fullName: true } } },
    });
    if (!membership) throw new NotFoundException('Organization user not found');
    if (membership.role === OrganizationRole.ORG_ADMIN && !actorIsOrgAdmin) {
      throw new ForbiddenException(
        'Only an organization admin can remove an organization admin',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.deletionAudit.create({
        data: {
          organizationId,
          entityType: 'ORGANIZATION_USER',
          entityId: userId,
          entityLabel: membership.user.fullName,
          reason: reason.trim(),
          deletedByUserId,
        },
      });
      await tx.organizationUser.delete({
        where: { organizationId_userId: { organizationId, userId } },
      });
    });
    invalidateUserSession(userId);
    return { id: userId, deleted: true };
  }

  private async createUserWithinOrganization(
    organization: { id: string; name: string; state: string | null },
    input: CreateOrganizationUserDto,
    actor: OrganizationActor,
  ) {
    const createdByUserId = actor.userId;

    if (!actor.isOrgAdmin) {
      if (input.role === OrganizationRole.ORG_ADMIN) {
        throw new ForbiddenException(
          'Only an organization admin can create another organization admin',
        );
      }
      if (input.role !== OrganizationRole.DRIVER) {
        this.assertCanGrantSectionAccess(actor, input.sectionAccess);
      }
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
    const temporaryPassword =
      input.password || this.generateTemporaryPassword();
    const passwordHash = await hash(temporaryPassword, 10);
    const resetPasswordToken = generateOneTimeToken();
    const resetHours = Number(
      this.configService.get<string>('PASSWORD_RESET_TTL_HOURS') ?? '24',
    );
    const resetPasswordTokenExpiresAt = new Date(
      Date.now() + resetHours * 60 * 60 * 1000,
    );
    const verificationToken = generateOneTimeToken();
    const verificationHours = Number(
      this.configService.get<string>('EMAIL_VERIFICATION_TTL_HOURS') ?? '168',
    );
    const verificationTokenExpiresAt = new Date(
      Date.now() + verificationHours * 60 * 60 * 1000,
    );

    const createdUser = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          fullName: input.fullName,
          email: input.email.toLowerCase(),
          phone: input.phone,
          passwordHash,
          status: UserStatus.ACTIVE,
          // Only SHA-256 hashes of the emailed tokens are stored.
          verificationToken: hashOneTimeToken(verificationToken),
          verificationTokenExpiresAt,
          approvedAt: now,
          approvedByUserId: createdByUserId,
          resetPasswordToken: hashOneTimeToken(resetPasswordToken),
          resetPasswordTokenExpiresAt,
        },
      });

      await tx.organizationUser.create({
        data: {
          organizationId: organization.id,
          userId: user.id,
          role: input.role,
          status: MembershipStatus.ACTIVE,
          sectionAccess: this.normalizeSectionAccess(
            input.role,
            input.sectionAccess,
          ),
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
        select: {
          ...SAFE_USER_WITH_DRIVER_SELECT,
          organizationMembers: true,
        },
      });
    });

    if (!createdUser) {
      throw new BadRequestException('Organization user could not be created');
    }

    try {
      await this.mailService.sendVerificationEmail({
        to: createdUser.email,
        fullName: createdUser.fullName,
        token: verificationToken,
      });
    } catch (error) {
      this.logger.error(
        `Organization user ${createdUser.id} was created but its verification email could not be sent.`,
        error instanceof Error ? error.stack : undefined,
      );
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

  /**
   * Section access to store for a membership. Default deny:
   * - ORG_ADMIN: full access (governed by role anyway).
   * - DRIVER: never gets portal sections (stored as NULL).
   * - Others: only what was explicitly granted; nothing if not provided.
   */
  private normalizeSectionAccess(
    role: OrganizationRole,
    input?: SectionAccessDto,
  ): Prisma.InputJsonValue | typeof Prisma.DbNull {
    if (role === OrganizationRole.DRIVER) {
      return Prisma.DbNull;
    }

    if (role === OrganizationRole.ORG_ADMIN) {
      return {
        fullAccess: true,
        sections: [],
      };
    }

    if (!input) {
      return {
        fullAccess: false,
        sections: [],
      };
    }

    if (input.fullAccess) {
      return {
        fullAccess: true,
        sections: [],
      };
    }

    const allowedSections = new Set(PORTAL_SECTION_KEYS);
    const sections = Array.from(
      new Set(
        (input.sections || [])
          .map((section) => section.trim().toLowerCase())
          .filter((section) => allowedSections.has(section)),
      ),
    );

    if (!sections.length) {
      throw new BadRequestException(
        'Select at least one portal section or enable full access',
      );
    }

    return {
      fullAccess: false,
      sections,
    };
  }

  private async ensureOrganizationIsActive(organizationId: string) {
    const organization = await this.ensureOrganizationExists(organizationId);

    if (organization.status !== OrganizationStatus.ACTIVE) {
      throw new BadRequestException(
        'Users can only be managed for active organizations',
      );
    }

    return organization;
  }

  private async ensureOrganizationExists(organizationId: string) {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
    });

    if (!organization) {
      throw new NotFoundException('Organization not found');
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
