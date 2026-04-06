import { Injectable } from '@nestjs/common';
import {
  PaymentCollectionMethod,
  PlanBillingCycle,
  PlanStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../shared/prisma/prisma.service';

const GLOBAL_SETTINGS_ID = 'global';

const DEFAULT_SETTINGS = {
  platformName: 'Ashwa Logix',
  supportEmail: 'support@ashwalogix.com',
  supportPhone: '+91 98765 43210',
  timezone: 'Asia/Kolkata',
  currency: 'INR',
  language: 'English',
  dateFormat: 'DD-MM-YYYY',
  regionalNote: '',
  autoApproval: false,
  requireDocumentVerification: true,
  tenantLimitPolicy: 'Standard',
  approvalWorkflow: 'Two-step approval',
  tenantOperationalLimit: '250 shipments/day',
  tenantReviewNote: '',
  defaultInvoicePrefix: 'ALX',
  billingGraceDays: '7',
  taxMode: 'GST inclusive',
  defaultPlanId: '',
  defaultPaymentCollectionMethod: 'MANUAL',
  allowManualActivationWithoutPayment: true,
  emailShipmentAlerts: true,
  emailDelayAlerts: true,
  emailDeliveryAlerts: true,
  smsShipmentAlerts: false,
  whatsappDelayAlerts: true,
  whatsappDeliveryAlerts: false,
  notificationTemplateName: 'Default Operations Template',
  notificationTemplateBody:
    'Hello {{name}}, shipment {{shipmentCode}} has an updated status: {{status}}.',
  sessionTimeoutMinutes: '45',
  maxLoginAttempts: '5',
  passwordMinLength: '10',
  requireUppercase: true,
  requireNumbers: true,
  requireSpecialChars: true,
  allowRememberMe: false,
  mapsProvider: 'Google Maps',
  mapsApiKey: '',
  messagingProvider: 'Twilio',
  messagingApiKey: '',
  externalApiEnabled: false,
  externalApiBaseUrl: '',
  externalApiKey: '',
  logoFile: null as string | null,
  brandPrimaryColor: '#7C3AED',
  brandSecondaryColor: '#1447E6',
  brandTagline: 'Control the logistics platform from one command center.',
  tenantIdPattern: 'TEN-{YYYY}-{SEQ4}',
  shipmentIdPattern: 'SHP-{YYYYMMDD}-{SEQ6}',
  dataRetentionDays: '365',
  auditRetentionDays: '730',
  enableDriverMarketplace: true,
  enableSmartTracking: true,
  enableExperimentalBilling: false,
};

type SettingsConfig = Record<string, unknown>;

@Injectable()
export class PlatformSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async getSettings() {
    await this.ensureSeedPlans();

    const [
      identity,
      governance,
      billing,
      notifications,
      security,
      integrations,
      branding,
      system,
      revision,
      plans,
    ] = await Promise.all([
      this.prisma.platformIdentitySetting.findUnique({ where: { id: GLOBAL_SETTINGS_ID } }),
      this.prisma.tenantGovernanceSetting.findUnique({ where: { id: GLOBAL_SETTINGS_ID } }),
      this.prisma.billingSetting.findUnique({ where: { id: GLOBAL_SETTINGS_ID } }),
      this.prisma.notificationSetting.findUnique({ where: { id: GLOBAL_SETTINGS_ID } }),
      this.prisma.securitySetting.findUnique({ where: { id: GLOBAL_SETTINGS_ID } }),
      this.prisma.integrationSetting.findUnique({ where: { id: GLOBAL_SETTINGS_ID } }),
      this.prisma.brandingSetting.findUnique({ where: { id: GLOBAL_SETTINGS_ID } }),
      this.prisma.systemSetting.findUnique({ where: { id: GLOBAL_SETTINGS_ID } }),
      this.prisma.platformSettingsRevision.findUnique({
        where: { id: GLOBAL_SETTINGS_ID },
        include: {
          updatedByUser: { select: { id: true, fullName: true, email: true } },
        },
      }),
      this.prisma.subscriptionPlan.findMany({
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      }),
    ]);

    return {
      config: {
        ...DEFAULT_SETTINGS,
        platformName: identity?.platformName ?? DEFAULT_SETTINGS.platformName,
        supportEmail: identity?.supportEmail ?? DEFAULT_SETTINGS.supportEmail,
        supportPhone: identity?.supportPhone ?? DEFAULT_SETTINGS.supportPhone,
        timezone: identity?.timezone ?? DEFAULT_SETTINGS.timezone,
        currency: identity?.currency ?? DEFAULT_SETTINGS.currency,
        language: identity?.language ?? DEFAULT_SETTINGS.language,
        dateFormat: identity?.dateFormat ?? DEFAULT_SETTINGS.dateFormat,
        regionalNote: identity?.regionalNote ?? DEFAULT_SETTINGS.regionalNote,
        autoApproval: governance?.autoApproval ?? DEFAULT_SETTINGS.autoApproval,
        requireDocumentVerification:
          governance?.requireDocumentVerification ?? DEFAULT_SETTINGS.requireDocumentVerification,
        tenantLimitPolicy: governance?.tenantLimitPolicy ?? DEFAULT_SETTINGS.tenantLimitPolicy,
        approvalWorkflow: governance?.approvalWorkflow ?? DEFAULT_SETTINGS.approvalWorkflow,
        tenantOperationalLimit:
          governance?.tenantOperationalLimit ?? DEFAULT_SETTINGS.tenantOperationalLimit,
        tenantReviewNote: governance?.tenantReviewNote ?? DEFAULT_SETTINGS.tenantReviewNote,
        plans: plans.length > 0 ? plans.map((plan) => this.mapPlanToConfig(plan)) : this.getDefaultPlanConfigs(),
        defaultInvoicePrefix:
          billing?.defaultInvoicePrefix ?? DEFAULT_SETTINGS.defaultInvoicePrefix,
        billingGraceDays: String(billing?.billingGraceDays ?? DEFAULT_SETTINGS.billingGraceDays),
        taxMode: billing?.taxMode ?? DEFAULT_SETTINGS.taxMode,
        defaultPlanId: billing?.defaultPlanId ?? DEFAULT_SETTINGS.defaultPlanId,
        defaultPaymentCollectionMethod:
          billing?.defaultPaymentCollectionMethod ?? DEFAULT_SETTINGS.defaultPaymentCollectionMethod,
        allowManualActivationWithoutPayment:
          billing?.allowManualActivationWithoutPayment ?? DEFAULT_SETTINGS.allowManualActivationWithoutPayment,
        emailShipmentAlerts:
          notifications?.emailShipmentAlerts ?? DEFAULT_SETTINGS.emailShipmentAlerts,
        emailDelayAlerts: notifications?.emailDelayAlerts ?? DEFAULT_SETTINGS.emailDelayAlerts,
        emailDeliveryAlerts:
          notifications?.emailDeliveryAlerts ?? DEFAULT_SETTINGS.emailDeliveryAlerts,
        smsShipmentAlerts: notifications?.smsShipmentAlerts ?? DEFAULT_SETTINGS.smsShipmentAlerts,
        whatsappDelayAlerts:
          notifications?.whatsappDelayAlerts ?? DEFAULT_SETTINGS.whatsappDelayAlerts,
        whatsappDeliveryAlerts:
          notifications?.whatsappDeliveryAlerts ?? DEFAULT_SETTINGS.whatsappDeliveryAlerts,
        notificationTemplateName:
          notifications?.notificationTemplateName ?? DEFAULT_SETTINGS.notificationTemplateName,
        notificationTemplateBody:
          notifications?.notificationTemplateBody ?? DEFAULT_SETTINGS.notificationTemplateBody,
        sessionTimeoutMinutes: String(
          security?.sessionTimeoutMinutes ?? DEFAULT_SETTINGS.sessionTimeoutMinutes,
        ),
        maxLoginAttempts: String(
          security?.maxLoginAttempts ?? DEFAULT_SETTINGS.maxLoginAttempts,
        ),
        passwordMinLength: String(
          security?.passwordMinLength ?? DEFAULT_SETTINGS.passwordMinLength,
        ),
        requireUppercase: security?.requireUppercase ?? DEFAULT_SETTINGS.requireUppercase,
        requireNumbers: security?.requireNumbers ?? DEFAULT_SETTINGS.requireNumbers,
        requireSpecialChars:
          security?.requireSpecialChars ?? DEFAULT_SETTINGS.requireSpecialChars,
        allowRememberMe: security?.allowRememberMe ?? DEFAULT_SETTINGS.allowRememberMe,
        mapsProvider: integrations?.mapsProvider ?? DEFAULT_SETTINGS.mapsProvider,
        mapsApiKey: integrations?.mapsApiKey ?? DEFAULT_SETTINGS.mapsApiKey,
        messagingProvider:
          integrations?.messagingProvider ?? DEFAULT_SETTINGS.messagingProvider,
        messagingApiKey: integrations?.messagingApiKey ?? DEFAULT_SETTINGS.messagingApiKey,
        externalApiEnabled:
          integrations?.externalApiEnabled ?? DEFAULT_SETTINGS.externalApiEnabled,
        externalApiBaseUrl:
          integrations?.externalApiBaseUrl ?? DEFAULT_SETTINGS.externalApiBaseUrl,
        externalApiKey: integrations?.externalApiKey ?? DEFAULT_SETTINGS.externalApiKey,
        logoFile: branding?.logoFile ?? DEFAULT_SETTINGS.logoFile,
        brandPrimaryColor:
          branding?.brandPrimaryColor ?? DEFAULT_SETTINGS.brandPrimaryColor,
        brandSecondaryColor:
          branding?.brandSecondaryColor ?? DEFAULT_SETTINGS.brandSecondaryColor,
        brandTagline: branding?.brandTagline ?? DEFAULT_SETTINGS.brandTagline,
        tenantIdPattern: system?.tenantIdPattern ?? DEFAULT_SETTINGS.tenantIdPattern,
        shipmentIdPattern:
          system?.shipmentIdPattern ?? DEFAULT_SETTINGS.shipmentIdPattern,
        dataRetentionDays: String(
          system?.dataRetentionDays ?? DEFAULT_SETTINGS.dataRetentionDays,
        ),
        auditRetentionDays: String(
          system?.auditRetentionDays ?? DEFAULT_SETTINGS.auditRetentionDays,
        ),
        enableDriverMarketplace:
          system?.enableDriverMarketplace ?? DEFAULT_SETTINGS.enableDriverMarketplace,
        enableSmartTracking:
          system?.enableSmartTracking ?? DEFAULT_SETTINGS.enableSmartTracking,
        enableExperimentalBilling:
          system?.enableExperimentalBilling ?? DEFAULT_SETTINGS.enableExperimentalBilling,
      },
      updatedAt: revision?.updatedAt ?? null,
      updatedByUser: revision?.updatedByUser ?? null,
    };
  }

  async listPlans(enabledOnly = false) {
    await this.ensureSeedPlans();

    const plans = await this.prisma.subscriptionPlan.findMany({
      where: enabledOnly ? { status: PlanStatus.ACTIVE } : undefined,
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });

    return plans.map((plan) => ({
      id: plan.id,
      code: plan.code,
      name: plan.name,
      description: plan.description,
      priceAmount: plan.priceAmount.toString(),
      currency: plan.currency,
      billingCycle: plan.billingCycle,
      tenantCap: plan.tenantCap,
      shipmentCapPerDay: plan.shipmentCapPerDay,
      graceDays: plan.graceDays,
      status: plan.status,
      isDefault: plan.isDefault,
    }));
  }

  async updateSettings(config: SettingsConfig, updatedByUserId: string) {
    await this.prisma.$transaction(async (tx) => {
      const syncedPlans = await this.syncPlans(
        tx,
        Array.isArray(config.plans) ? config.plans : [],
      );
      const defaultPlanId = this.resolveDefaultPlanId(config, syncedPlans);

      await tx.subscriptionPlan.updateMany({
        data: { isDefault: false },
      });

      if (defaultPlanId) {
        await tx.subscriptionPlan.update({
          where: { id: defaultPlanId },
          data: { isDefault: true },
        });
      }

      await tx.platformIdentitySetting.upsert({
        where: { id: GLOBAL_SETTINGS_ID },
        update: {
          platformName: this.stringValue(config.platformName, DEFAULT_SETTINGS.platformName),
          supportEmail: this.optionalStringValue(config.supportEmail, DEFAULT_SETTINGS.supportEmail),
          supportPhone: this.optionalStringValue(config.supportPhone, DEFAULT_SETTINGS.supportPhone),
          timezone: this.stringValue(config.timezone, DEFAULT_SETTINGS.timezone),
          currency: this.stringValue(config.currency, DEFAULT_SETTINGS.currency),
          language: this.stringValue(config.language, DEFAULT_SETTINGS.language),
          dateFormat: this.stringValue(config.dateFormat, DEFAULT_SETTINGS.dateFormat),
          regionalNote: this.optionalStringValue(config.regionalNote, DEFAULT_SETTINGS.regionalNote),
        },
        create: {
          id: GLOBAL_SETTINGS_ID,
          platformName: this.stringValue(config.platformName, DEFAULT_SETTINGS.platformName),
          supportEmail: this.optionalStringValue(config.supportEmail, DEFAULT_SETTINGS.supportEmail),
          supportPhone: this.optionalStringValue(config.supportPhone, DEFAULT_SETTINGS.supportPhone),
          timezone: this.stringValue(config.timezone, DEFAULT_SETTINGS.timezone),
          currency: this.stringValue(config.currency, DEFAULT_SETTINGS.currency),
          language: this.stringValue(config.language, DEFAULT_SETTINGS.language),
          dateFormat: this.stringValue(config.dateFormat, DEFAULT_SETTINGS.dateFormat),
          regionalNote: this.optionalStringValue(config.regionalNote, DEFAULT_SETTINGS.regionalNote),
        },
      });

      await tx.tenantGovernanceSetting.upsert({
        where: { id: GLOBAL_SETTINGS_ID },
        update: {
          autoApproval: this.booleanValue(config.autoApproval, DEFAULT_SETTINGS.autoApproval),
          requireDocumentVerification: this.booleanValue(
            config.requireDocumentVerification,
            DEFAULT_SETTINGS.requireDocumentVerification,
          ),
          tenantLimitPolicy: this.stringValue(config.tenantLimitPolicy, DEFAULT_SETTINGS.tenantLimitPolicy),
          approvalWorkflow: this.stringValue(config.approvalWorkflow, DEFAULT_SETTINGS.approvalWorkflow),
          tenantOperationalLimit: this.optionalStringValue(
            config.tenantOperationalLimit,
            DEFAULT_SETTINGS.tenantOperationalLimit,
          ),
          tenantReviewNote: this.optionalStringValue(
            config.tenantReviewNote,
            DEFAULT_SETTINGS.tenantReviewNote,
          ),
        },
        create: {
          id: GLOBAL_SETTINGS_ID,
          autoApproval: this.booleanValue(config.autoApproval, DEFAULT_SETTINGS.autoApproval),
          requireDocumentVerification: this.booleanValue(
            config.requireDocumentVerification,
            DEFAULT_SETTINGS.requireDocumentVerification,
          ),
          tenantLimitPolicy: this.stringValue(config.tenantLimitPolicy, DEFAULT_SETTINGS.tenantLimitPolicy),
          approvalWorkflow: this.stringValue(config.approvalWorkflow, DEFAULT_SETTINGS.approvalWorkflow),
          tenantOperationalLimit: this.optionalStringValue(
            config.tenantOperationalLimit,
            DEFAULT_SETTINGS.tenantOperationalLimit,
          ),
          tenantReviewNote: this.optionalStringValue(
            config.tenantReviewNote,
            DEFAULT_SETTINGS.tenantReviewNote,
          ),
        },
      });

      await tx.billingSetting.upsert({
        where: { id: GLOBAL_SETTINGS_ID },
        update: {
          defaultInvoicePrefix: this.stringValue(
            config.defaultInvoicePrefix,
            DEFAULT_SETTINGS.defaultInvoicePrefix,
          ),
          billingGraceDays: this.numberValue(
            config.billingGraceDays,
            Number(DEFAULT_SETTINGS.billingGraceDays),
          ),
          taxMode: this.stringValue(config.taxMode, DEFAULT_SETTINGS.taxMode),
          defaultPlanId,
          defaultPaymentCollectionMethod: this.paymentCollectionMethodValue(
            config.defaultPaymentCollectionMethod,
          ),
          allowManualActivationWithoutPayment: this.booleanValue(
            config.allowManualActivationWithoutPayment,
            DEFAULT_SETTINGS.allowManualActivationWithoutPayment,
          ),
        },
        create: {
          id: GLOBAL_SETTINGS_ID,
          defaultInvoicePrefix: this.stringValue(
            config.defaultInvoicePrefix,
            DEFAULT_SETTINGS.defaultInvoicePrefix,
          ),
          billingGraceDays: this.numberValue(
            config.billingGraceDays,
            Number(DEFAULT_SETTINGS.billingGraceDays),
          ),
          taxMode: this.stringValue(config.taxMode, DEFAULT_SETTINGS.taxMode),
          defaultPlanId,
          defaultPaymentCollectionMethod: this.paymentCollectionMethodValue(
            config.defaultPaymentCollectionMethod,
          ),
          allowManualActivationWithoutPayment: this.booleanValue(
            config.allowManualActivationWithoutPayment,
            DEFAULT_SETTINGS.allowManualActivationWithoutPayment,
          ),
        },
      });

      await tx.notificationSetting.upsert({
        where: { id: GLOBAL_SETTINGS_ID },
        update: {
          emailShipmentAlerts: this.booleanValue(
            config.emailShipmentAlerts,
            DEFAULT_SETTINGS.emailShipmentAlerts,
          ),
          emailDelayAlerts: this.booleanValue(
            config.emailDelayAlerts,
            DEFAULT_SETTINGS.emailDelayAlerts,
          ),
          emailDeliveryAlerts: this.booleanValue(
            config.emailDeliveryAlerts,
            DEFAULT_SETTINGS.emailDeliveryAlerts,
          ),
          smsShipmentAlerts: this.booleanValue(
            config.smsShipmentAlerts,
            DEFAULT_SETTINGS.smsShipmentAlerts,
          ),
          whatsappDelayAlerts: this.booleanValue(
            config.whatsappDelayAlerts,
            DEFAULT_SETTINGS.whatsappDelayAlerts,
          ),
          whatsappDeliveryAlerts: this.booleanValue(
            config.whatsappDeliveryAlerts,
            DEFAULT_SETTINGS.whatsappDeliveryAlerts,
          ),
          notificationTemplateName: this.optionalStringValue(
            config.notificationTemplateName,
            DEFAULT_SETTINGS.notificationTemplateName,
          ),
          notificationTemplateBody: this.optionalStringValue(
            config.notificationTemplateBody,
            DEFAULT_SETTINGS.notificationTemplateBody,
          ),
        },
        create: {
          id: GLOBAL_SETTINGS_ID,
          emailShipmentAlerts: this.booleanValue(
            config.emailShipmentAlerts,
            DEFAULT_SETTINGS.emailShipmentAlerts,
          ),
          emailDelayAlerts: this.booleanValue(
            config.emailDelayAlerts,
            DEFAULT_SETTINGS.emailDelayAlerts,
          ),
          emailDeliveryAlerts: this.booleanValue(
            config.emailDeliveryAlerts,
            DEFAULT_SETTINGS.emailDeliveryAlerts,
          ),
          smsShipmentAlerts: this.booleanValue(
            config.smsShipmentAlerts,
            DEFAULT_SETTINGS.smsShipmentAlerts,
          ),
          whatsappDelayAlerts: this.booleanValue(
            config.whatsappDelayAlerts,
            DEFAULT_SETTINGS.whatsappDelayAlerts,
          ),
          whatsappDeliveryAlerts: this.booleanValue(
            config.whatsappDeliveryAlerts,
            DEFAULT_SETTINGS.whatsappDeliveryAlerts,
          ),
          notificationTemplateName: this.optionalStringValue(
            config.notificationTemplateName,
            DEFAULT_SETTINGS.notificationTemplateName,
          ),
          notificationTemplateBody: this.optionalStringValue(
            config.notificationTemplateBody,
            DEFAULT_SETTINGS.notificationTemplateBody,
          ),
        },
      });

      await tx.securitySetting.upsert({
        where: { id: GLOBAL_SETTINGS_ID },
        update: {
          sessionTimeoutMinutes: this.numberValue(
            config.sessionTimeoutMinutes,
            Number(DEFAULT_SETTINGS.sessionTimeoutMinutes),
          ),
          maxLoginAttempts: this.numberValue(
            config.maxLoginAttempts,
            Number(DEFAULT_SETTINGS.maxLoginAttempts),
          ),
          passwordMinLength: this.numberValue(
            config.passwordMinLength,
            Number(DEFAULT_SETTINGS.passwordMinLength),
          ),
          requireUppercase: this.booleanValue(
            config.requireUppercase,
            DEFAULT_SETTINGS.requireUppercase,
          ),
          requireNumbers: this.booleanValue(
            config.requireNumbers,
            DEFAULT_SETTINGS.requireNumbers,
          ),
          requireSpecialChars: this.booleanValue(
            config.requireSpecialChars,
            DEFAULT_SETTINGS.requireSpecialChars,
          ),
          allowRememberMe: this.booleanValue(
            config.allowRememberMe,
            DEFAULT_SETTINGS.allowRememberMe,
          ),
        },
        create: {
          id: GLOBAL_SETTINGS_ID,
          sessionTimeoutMinutes: this.numberValue(
            config.sessionTimeoutMinutes,
            Number(DEFAULT_SETTINGS.sessionTimeoutMinutes),
          ),
          maxLoginAttempts: this.numberValue(
            config.maxLoginAttempts,
            Number(DEFAULT_SETTINGS.maxLoginAttempts),
          ),
          passwordMinLength: this.numberValue(
            config.passwordMinLength,
            Number(DEFAULT_SETTINGS.passwordMinLength),
          ),
          requireUppercase: this.booleanValue(
            config.requireUppercase,
            DEFAULT_SETTINGS.requireUppercase,
          ),
          requireNumbers: this.booleanValue(
            config.requireNumbers,
            DEFAULT_SETTINGS.requireNumbers,
          ),
          requireSpecialChars: this.booleanValue(
            config.requireSpecialChars,
            DEFAULT_SETTINGS.requireSpecialChars,
          ),
          allowRememberMe: this.booleanValue(
            config.allowRememberMe,
            DEFAULT_SETTINGS.allowRememberMe,
          ),
        },
      });

      await tx.integrationSetting.upsert({
        where: { id: GLOBAL_SETTINGS_ID },
        update: {
          mapsProvider: this.stringValue(
            config.mapsProvider,
            DEFAULT_SETTINGS.mapsProvider,
          ),
          mapsApiKey: this.optionalStringValue(
            config.mapsApiKey,
            DEFAULT_SETTINGS.mapsApiKey,
          ),
          messagingProvider: this.stringValue(
            config.messagingProvider,
            DEFAULT_SETTINGS.messagingProvider,
          ),
          messagingApiKey: this.optionalStringValue(
            config.messagingApiKey,
            DEFAULT_SETTINGS.messagingApiKey,
          ),
          externalApiEnabled: this.booleanValue(
            config.externalApiEnabled,
            DEFAULT_SETTINGS.externalApiEnabled,
          ),
          externalApiBaseUrl: this.optionalStringValue(
            config.externalApiBaseUrl,
            DEFAULT_SETTINGS.externalApiBaseUrl,
          ),
          externalApiKey: this.optionalStringValue(
            config.externalApiKey,
            DEFAULT_SETTINGS.externalApiKey,
          ),
        },
        create: {
          id: GLOBAL_SETTINGS_ID,
          mapsProvider: this.stringValue(
            config.mapsProvider,
            DEFAULT_SETTINGS.mapsProvider,
          ),
          mapsApiKey: this.optionalStringValue(
            config.mapsApiKey,
            DEFAULT_SETTINGS.mapsApiKey,
          ),
          messagingProvider: this.stringValue(
            config.messagingProvider,
            DEFAULT_SETTINGS.messagingProvider,
          ),
          messagingApiKey: this.optionalStringValue(
            config.messagingApiKey,
            DEFAULT_SETTINGS.messagingApiKey,
          ),
          externalApiEnabled: this.booleanValue(
            config.externalApiEnabled,
            DEFAULT_SETTINGS.externalApiEnabled,
          ),
          externalApiBaseUrl: this.optionalStringValue(
            config.externalApiBaseUrl,
            DEFAULT_SETTINGS.externalApiBaseUrl,
          ),
          externalApiKey: this.optionalStringValue(
            config.externalApiKey,
            DEFAULT_SETTINGS.externalApiKey,
          ),
        },
      });

      await tx.brandingSetting.upsert({
        where: { id: GLOBAL_SETTINGS_ID },
        update: {
          logoFile: this.optionalStringValue(config.logoFile, null),
          brandPrimaryColor: this.stringValue(
            config.brandPrimaryColor,
            DEFAULT_SETTINGS.brandPrimaryColor,
          ),
          brandSecondaryColor: this.stringValue(
            config.brandSecondaryColor,
            DEFAULT_SETTINGS.brandSecondaryColor,
          ),
          brandTagline: this.optionalStringValue(
            config.brandTagline,
            DEFAULT_SETTINGS.brandTagline,
          ),
        },
        create: {
          id: GLOBAL_SETTINGS_ID,
          logoFile: this.optionalStringValue(config.logoFile, null),
          brandPrimaryColor: this.stringValue(
            config.brandPrimaryColor,
            DEFAULT_SETTINGS.brandPrimaryColor,
          ),
          brandSecondaryColor: this.stringValue(
            config.brandSecondaryColor,
            DEFAULT_SETTINGS.brandSecondaryColor,
          ),
          brandTagline: this.optionalStringValue(
            config.brandTagline,
            DEFAULT_SETTINGS.brandTagline,
          ),
        },
      });

      await tx.systemSetting.upsert({
        where: { id: GLOBAL_SETTINGS_ID },
        update: {
          tenantIdPattern: this.stringValue(
            config.tenantIdPattern,
            DEFAULT_SETTINGS.tenantIdPattern,
          ),
          shipmentIdPattern: this.stringValue(
            config.shipmentIdPattern,
            DEFAULT_SETTINGS.shipmentIdPattern,
          ),
          dataRetentionDays: this.numberValue(
            config.dataRetentionDays,
            Number(DEFAULT_SETTINGS.dataRetentionDays),
          ),
          auditRetentionDays: this.numberValue(
            config.auditRetentionDays,
            Number(DEFAULT_SETTINGS.auditRetentionDays),
          ),
          enableDriverMarketplace: this.booleanValue(
            config.enableDriverMarketplace,
            DEFAULT_SETTINGS.enableDriverMarketplace,
          ),
          enableSmartTracking: this.booleanValue(
            config.enableSmartTracking,
            DEFAULT_SETTINGS.enableSmartTracking,
          ),
          enableExperimentalBilling: this.booleanValue(
            config.enableExperimentalBilling,
            DEFAULT_SETTINGS.enableExperimentalBilling,
          ),
        },
        create: {
          id: GLOBAL_SETTINGS_ID,
          tenantIdPattern: this.stringValue(
            config.tenantIdPattern,
            DEFAULT_SETTINGS.tenantIdPattern,
          ),
          shipmentIdPattern: this.stringValue(
            config.shipmentIdPattern,
            DEFAULT_SETTINGS.shipmentIdPattern,
          ),
          dataRetentionDays: this.numberValue(
            config.dataRetentionDays,
            Number(DEFAULT_SETTINGS.dataRetentionDays),
          ),
          auditRetentionDays: this.numberValue(
            config.auditRetentionDays,
            Number(DEFAULT_SETTINGS.auditRetentionDays),
          ),
          enableDriverMarketplace: this.booleanValue(
            config.enableDriverMarketplace,
            DEFAULT_SETTINGS.enableDriverMarketplace,
          ),
          enableSmartTracking: this.booleanValue(
            config.enableSmartTracking,
            DEFAULT_SETTINGS.enableSmartTracking,
          ),
          enableExperimentalBilling: this.booleanValue(
            config.enableExperimentalBilling,
            DEFAULT_SETTINGS.enableExperimentalBilling,
          ),
        },
      });

      await tx.platformSettingsRevision.upsert({
        where: { id: GLOBAL_SETTINGS_ID },
        update: { updatedByUserId },
        create: { id: GLOBAL_SETTINGS_ID, updatedByUserId },
      });
    });

    return this.getSettings();
  }

  private async ensureSeedPlans() {
    const existingPlanCount = await this.prisma.subscriptionPlan.count();

    if (existingPlanCount > 0) {
      return;
    }

    const freePlan = await this.prisma.subscriptionPlan.create({
      data: {
        code: 'FREE',
        name: 'Free',
        description:
          'Default onboarding plan for early tenant activation without payment gateway dependency.',
        priceAmount: new Prisma.Decimal('0'),
        currency: 'INR',
        billingCycle: PlanBillingCycle.MONTHLY,
        tenantCap: 1,
        shipmentCapPerDay: 100,
        graceDays: 0,
        sortOrder: 0,
        status: PlanStatus.ACTIVE,
        isDefault: true,
        metadata: {
          requiresPayment: false,
          onboardingSafe: true,
        } as Prisma.InputJsonValue,
      },
    });

    await this.prisma.billingSetting.upsert({
      where: { id: GLOBAL_SETTINGS_ID },
      update: {
        defaultPlanId: freePlan.id,
        defaultPaymentCollectionMethod: PaymentCollectionMethod.NONE,
        allowManualActivationWithoutPayment: true,
      },
      create: {
        id: GLOBAL_SETTINGS_ID,
        defaultInvoicePrefix: DEFAULT_SETTINGS.defaultInvoicePrefix,
        billingGraceDays: Number(DEFAULT_SETTINGS.billingGraceDays),
        taxMode: DEFAULT_SETTINGS.taxMode,
        defaultPlanId: freePlan.id,
        defaultPaymentCollectionMethod: PaymentCollectionMethod.NONE,
        allowManualActivationWithoutPayment: true,
      },
    });
  }

  private async syncPlans(tx: Prisma.TransactionClient, plansInput: unknown[]) {
    const existingPlans = await tx.subscriptionPlan.findMany();
    const syncedPlanIds: string[] = [];

    for (const [index, rawPlan] of plansInput.entries()) {
      if (!rawPlan || typeof rawPlan !== 'object') {
        continue;
      }

      const plan = rawPlan as Record<string, unknown>;
      const incomingId = this.optionalStringValue(plan.id, '') ?? '';
      const code = this.buildPlanCode(
        incomingId || this.stringValue(plan.name, `PLAN-${index + 1}`),
      );
      const existingPlan = this.isUuid(incomingId)
        ? existingPlans.find((candidate) => candidate.id === incomingId)
        : existingPlans.find((candidate) => candidate.code === code);

      const payload: Prisma.SubscriptionPlanUncheckedCreateInput = {
        code: existingPlan?.code ?? code,
        name: this.stringValue(plan.name, `Plan ${index + 1}`),
        description: this.optionalStringValue(plan.description, null),
        priceAmount: this.decimalValue(plan.price, '0'),
        currency: this.stringValue(plan.currency, DEFAULT_SETTINGS.currency).toUpperCase(),
        billingCycle: this.planBillingCycleValue(plan.billingCycle),
        tenantCap: this.integerValueOrNull(plan.tenantCap),
        shipmentCapPerDay: this.integerValueOrNull(plan.shipmentCapPerDay),
        graceDays: this.integerValueOrNull(plan.graceDays),
        sortOrder: index,
        status: this.booleanValue(plan.enabled, true)
          ? PlanStatus.ACTIVE
          : PlanStatus.INACTIVE,
        metadata:
          plan.metadata && typeof plan.metadata === 'object'
            ? (plan.metadata as Prisma.InputJsonValue)
            : Prisma.JsonNull,
      };

      const syncedPlan = existingPlan
        ? await tx.subscriptionPlan.update({
            where: { id: existingPlan.id },
            data: payload,
          })
        : await tx.subscriptionPlan.create({
            data: payload,
          });

      syncedPlanIds.push(syncedPlan.id);
    }

    if (syncedPlanIds.length > 0) {
      await tx.subscriptionPlan.updateMany({
        where: { id: { notIn: syncedPlanIds } },
        data: { status: PlanStatus.INACTIVE },
      });
    }

    return tx.subscriptionPlan.findMany({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  private resolveDefaultPlanId(
    config: SettingsConfig,
    plans: Array<{ id: string; status: PlanStatus }>,
  ) {
    const configuredDefaultPlanId = this.optionalStringValue(
      config.defaultPlanId,
      '',
    );

    if (
      configuredDefaultPlanId &&
      plans.some((plan) => plan.id === configuredDefaultPlanId)
    ) {
      return configuredDefaultPlanId;
    }

    return plans.find((plan) => plan.status === PlanStatus.ACTIVE)?.id ?? null;
  }

  private mapPlanToConfig(plan: {
    id: string;
    code: string;
    name: string;
    description: string | null;
    priceAmount: Prisma.Decimal;
    billingCycle: PlanBillingCycle;
    tenantCap: number | null;
    status: PlanStatus;
    currency: string;
    isDefault: boolean;
  }) {
    return {
      id: plan.id,
      code: plan.code,
      name: plan.name,
      price: plan.priceAmount.toString(),
      billingCycle: this.planBillingCycleLabel(plan.billingCycle),
      tenantCap: plan.tenantCap ? `${plan.tenantCap} tenants` : '',
      enabled: plan.status === PlanStatus.ACTIVE,
      description: plan.description ?? '',
      currency: plan.currency,
      isDefault: plan.isDefault,
    };
  }

  private getDefaultPlanConfigs() {
    return [
      {
        id: 'starter',
        name: 'Starter',
        price: '4999',
        billingCycle: 'Monthly',
        tenantCap: '1 tenant',
        enabled: true,
        description: 'For small operations onboarding onto the platform.',
        currency: 'INR',
        isDefault: false,
      },
      {
        id: 'growth',
        name: 'Growth',
        price: '14999',
        billingCycle: 'Monthly',
        tenantCap: '5 tenants',
        enabled: true,
        description: 'For expanding operations teams with multiple branches.',
        currency: 'INR',
        isDefault: false,
      },
    ];
  }

  private stringValue(value: unknown, fallback: string) {
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
  }

  private optionalStringValue(value: unknown, fallback: string | null) {
    if (typeof value !== 'string') {
      return fallback;
    }

    const trimmed = value.trim();
    return trimmed ? trimmed : fallback;
  }

  private booleanValue(value: unknown, fallback: boolean) {
    return typeof value === 'boolean' ? value : fallback;
  }

  private numberValue(value: unknown, fallback: number) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  private integerValueOrNull(value: unknown) {
    const parsed = parseInt(String(value ?? '').replace(/[^\d]/g, ''), 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private decimalValue(value: unknown, fallback: string) {
    const normalized =
      typeof value === 'string'
        ? value.replace(/[^0-9.]/g, '')
        : typeof value === 'number'
          ? String(value)
          : fallback;

    return new Prisma.Decimal(normalized || fallback);
  }

  private buildPlanCode(value: string) {
    const normalized = value
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');

    return normalized || `PLAN_${Date.now()}`;
  }

  private planBillingCycleValue(value: unknown) {
    const normalized = this.stringValue(value, 'Monthly').toUpperCase();

    if (
      normalized === PlanBillingCycle.MONTHLY ||
      normalized === PlanBillingCycle.QUARTERLY ||
      normalized === PlanBillingCycle.YEARLY ||
      normalized === PlanBillingCycle.ONE_TIME ||
      normalized === PlanBillingCycle.CUSTOM
    ) {
      return normalized as PlanBillingCycle;
    }

    if (normalized.includes('QUARTER')) return PlanBillingCycle.QUARTERLY;
    if (normalized.includes('YEAR')) return PlanBillingCycle.YEARLY;
    if (normalized.includes('ONE')) return PlanBillingCycle.ONE_TIME;
    if (normalized.includes('CUSTOM')) return PlanBillingCycle.CUSTOM;

    return PlanBillingCycle.MONTHLY;
  }

  private planBillingCycleLabel(value: PlanBillingCycle) {
    switch (value) {
      case PlanBillingCycle.QUARTERLY:
        return 'Quarterly';
      case PlanBillingCycle.YEARLY:
        return 'Yearly';
      case PlanBillingCycle.ONE_TIME:
        return 'One-time';
      case PlanBillingCycle.CUSTOM:
        return 'Custom';
      default:
        return 'Monthly';
    }
  }

  private paymentCollectionMethodValue(value: unknown) {
    const normalized = this.stringValue(value, 'MANUAL').toUpperCase();

    if (
      normalized === PaymentCollectionMethod.NONE ||
      normalized === PaymentCollectionMethod.MANUAL ||
      normalized === PaymentCollectionMethod.OFFLINE ||
      normalized === PaymentCollectionMethod.DEFERRED
    ) {
      return normalized as PaymentCollectionMethod;
    }

    return PaymentCollectionMethod.MANUAL;
  }

  private isUuid(value: string) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    );
  }
}
