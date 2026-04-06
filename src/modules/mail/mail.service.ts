import { SendEmailCommand, SESClient } from '@aws-sdk/client-ses';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly sesClient: SESClient | null;
  private readonly fromEmail: string | null;
  private readonly replyToEmail: string | null;
  private readonly frontendBaseUrl: string;
  private readonly mailEnabled: boolean;

  constructor(private readonly configService: ConfigService) {
    const region = this.configService.get<string>('AWS_REGION') || 'us-east-1';
    this.fromEmail = this.configService.get<string>('MAIL_FROM_EMAIL') || null;
    this.replyToEmail = this.configService.get<string>('MAIL_REPLY_TO_EMAIL') || null;
    this.frontendBaseUrl =
      this.configService.get<string>('FRONTEND_BASE_URL') || 'http://localhost:5173';
    this.mailEnabled =
      String(this.configService.get<string>('MAIL_ENABLED') || 'false').toLowerCase() ===
      'true';

    this.sesClient = this.mailEnabled && this.fromEmail ? new SESClient({ region }) : null;
  }

  async sendVerificationEmail(input: {
    to: string;
    fullName: string;
    token: string;
  }) {
    const verificationUrl = `${this.frontendBaseUrl}/verify-email?token=${encodeURIComponent(input.token)}`;

    await this.sendEmail({
      to: input.to,
      subject: 'Verify your Ashwa Logix account',
      html: this.wrapTemplate({
        title: 'Verify your email',
        intro: `Hello ${this.escape(input.fullName)},`,
        body: 'Use the button below to verify your account and continue the onboarding process.',
        ctaLabel: 'Verify email',
        ctaUrl: verificationUrl,
        footer: 'If the button does not work, open the link shown below in your browser.',
      }),
      text: `Hello ${input.fullName}, verify your Ashwa Logix account here: ${verificationUrl}`,
    });
  }

  async sendPasswordResetEmail(input: {
    to: string;
    fullName: string;
    token: string;
  }) {
    const resetUrl = `${this.frontendBaseUrl}/forgot-password?token=${encodeURIComponent(input.token)}`;

    await this.sendEmail({
      to: input.to,
      subject: 'Reset your Ashwa Logix password',
      html: this.wrapTemplate({
        title: 'Reset your password',
        intro: `Hello ${this.escape(input.fullName)},`,
        body: 'Use the button below to reset your password.',
        ctaLabel: 'Reset password',
        ctaUrl: resetUrl,
        footer: 'If you did not request a password reset, you can ignore this email.',
      }),
      text: `Hello ${input.fullName}, reset your Ashwa Logix password here: ${resetUrl}`,
    });
  }

  async sendSuperAdminOtpEmail(input: {
    to: string;
    fullName: string;
    otp: string;
    expiresInMinutes: number;
  }) {
    await this.sendEmail({
      to: input.to,
      subject: 'Your Ashwa Logix super admin OTP',
      html: this.wrapTemplate({
        title: 'Super admin sign-in verification',
        intro: `Hello ${this.escape(input.fullName)},`,
        body: `Use this one-time password to finish signing in: <strong style="font-size:24px;letter-spacing:6px;">${this.escape(input.otp)}</strong><br/><br/>This code expires in ${input.expiresInMinutes} minutes.`,
        footer:
          'If you did not attempt to sign in, you can ignore this email and review your account access.',
      }),
      text: `Hello ${input.fullName}, your Ashwa Logix super admin OTP is ${input.otp}. It expires in ${input.expiresInMinutes} minutes.`,
    });
  }

  async sendOrganizationApprovedEmail(input: {
    to: string;
    fullName: string;
    organizationName: string;
    notes?: string | null;
  }) {
    const loginUrl = `${this.frontendBaseUrl}/login`;
    const notes = input.notes ? `Approval notes: ${this.escape(input.notes)}` : '';

    await this.sendEmail({
      to: input.to,
      subject: 'Your company has been approved on Ashwa Logix',
      html: this.wrapTemplate({
        title: 'Company approved',
        intro: `Hello ${this.escape(input.fullName)},`,
        body: `${this.escape(input.organizationName)} has been approved. You can now sign in and start using the platform.${notes ? `<br/><br/>${notes}` : ''}`,
        ctaLabel: 'Go to login',
        ctaUrl: loginUrl,
        footer: 'If you need help signing in, reply to this email or contact support.',
      }),
      text: `Hello ${input.fullName}, ${input.organizationName} has been approved. Sign in here: ${loginUrl}${input.notes ? ` Notes: ${input.notes}` : ''}`,
    });
  }

  async sendOrganizationRejectedEmail(input: {
    to: string;
    fullName: string;
    organizationName: string;
    reason: string;
  }) {
    await this.sendEmail({
      to: input.to,
      subject: 'Your company registration was not approved',
      html: this.wrapTemplate({
        title: 'Company registration update',
        intro: `Hello ${this.escape(input.fullName)},`,
        body: `${this.escape(input.organizationName)} was not approved at this time.<br/><br/><strong>Reason:</strong> ${this.escape(input.reason)}`,
        footer: 'You can reply to this email after updating the required information.',
      }),
      text: `Hello ${input.fullName}, ${input.organizationName} was not approved. Reason: ${input.reason}`,
    });
  }

  async sendIndependentDriverApprovedEmail(input: {
    to: string;
    fullName: string;
    notes?: string | null;
  }) {
    const loginUrl = `${this.frontendBaseUrl}/login`;

    await this.sendEmail({
      to: input.to,
      subject: 'Your independent driver registration was approved',
      html: this.wrapTemplate({
        title: 'Registration approved',
        intro: `Hello ${this.escape(input.fullName)},`,
        body: `Your independent driver registration has been approved.${input.notes ? `<br/><br/>Notes: ${this.escape(input.notes)}` : ''}`,
        ctaLabel: 'Open Ashwa Logix',
        ctaUrl: loginUrl,
        footer: 'If your account setup requires additional steps, our team will contact you shortly.',
      }),
      text: `Hello ${input.fullName}, your independent driver registration has been approved.${input.notes ? ` Notes: ${input.notes}` : ''} Open Ashwa Logix here: ${loginUrl}`,
    });
  }

  async sendIndependentDriverRejectedEmail(input: {
    to: string;
    fullName: string;
    reason: string;
  }) {
    await this.sendEmail({
      to: input.to,
      subject: 'Your independent driver registration was not approved',
      html: this.wrapTemplate({
        title: 'Registration update',
        intro: `Hello ${this.escape(input.fullName)},`,
        body: `Your independent driver registration was not approved at this time.<br/><br/><strong>Reason:</strong> ${this.escape(input.reason)}`,
        footer: 'You can contact support or reapply after updating the required documents.',
      }),
      text: `Hello ${input.fullName}, your independent driver registration was not approved. Reason: ${input.reason}`,
    });
  }

  async sendOrganizationUserInvitationEmail(input: {
    to: string;
    fullName: string;
    organizationName: string;
    roleLabel: string;
    token: string;
  }) {
    const setupUrl = `${this.frontendBaseUrl}/forgot-password?token=${encodeURIComponent(input.token)}`;

    await this.sendEmail({
      to: input.to,
      subject: `Your ${input.organizationName} Ashwa Logix account is ready`,
      html: this.wrapTemplate({
        title: 'Account invitation',
        intro: `Hello ${this.escape(input.fullName)},`,
        body: `An Ashwa Logix account has been created for you as ${this.escape(input.roleLabel)} in ${this.escape(input.organizationName)}. Use the button below to set your password and sign in.`,
        ctaLabel: 'Set password',
        ctaUrl: setupUrl,
        footer: 'If the button does not work, open the link shown below in your browser.',
      }),
      text: `Hello ${input.fullName}, an Ashwa Logix account has been created for you as ${input.roleLabel} in ${input.organizationName}. Set your password here: ${setupUrl}`,
    });
  }

  private async sendEmail(input: {
    to: string;
    subject: string;
    html: string;
    text: string;
  }) {
    if (!this.sesClient || !this.fromEmail) {
      this.logger.warn(
        `Mail delivery skipped because MAIL_ENABLED or MAIL_FROM_EMAIL is not configured. Intended recipient: ${input.to}`,
      );
      return;
    }

    await this.sesClient.send(
      new SendEmailCommand({
        Source: this.fromEmail,
        Destination: {
          ToAddresses: [input.to],
        },
        ReplyToAddresses: this.replyToEmail ? [this.replyToEmail] : undefined,
        Message: {
          Subject: {
            Charset: 'UTF-8',
            Data: input.subject,
          },
          Body: {
            Html: {
              Charset: 'UTF-8',
              Data: input.html,
            },
            Text: {
              Charset: 'UTF-8',
              Data: input.text,
            },
          },
        },
      }),
    );
  }

  private wrapTemplate(input: {
    title: string;
    intro: string;
    body: string;
    ctaLabel?: string;
    ctaUrl?: string;
    footer?: string;
  }) {
    const cta =
      input.ctaLabel && input.ctaUrl
        ? `<p><a href="${input.ctaUrl}" style="display:inline-block;padding:12px 18px;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:8px;">${this.escape(input.ctaLabel)}</a></p><p style="word-break:break-all;color:#475569;">${input.ctaUrl}</p>`
        : '';

    return `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #0f172a; max-width: 640px; margin: 0 auto;">
        <h2>${this.escape(input.title)}</h2>
        <p>${input.intro}</p>
        <p>${input.body}</p>
        ${cta}
        ${input.footer ? `<p style="color:#475569;">${input.footer}</p>` : ''}
      </div>
    `;
  }

  private escape(value: string) {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}
