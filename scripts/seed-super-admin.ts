import 'dotenv/config';
import { ConfigService } from '@nestjs/config';
import { PlatformRole, UserStatus } from '@prisma/client';
import { hash } from 'bcryptjs';
import { PrismaService } from '../src/shared/prisma/prisma.service';

async function main() {
  const configService = new ConfigService();
  const prisma = new PrismaService(configService);

  const emails = [
    ...new Set(
      (
        process.env.SUPER_ADMIN_EMAILS ??
        process.env.SUPER_ADMIN_EMAIL ??
        ''
      )
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  const password = process.env.SUPER_ADMIN_PASSWORD;
  const fullName = process.env.SUPER_ADMIN_NAME ?? 'Ashwa Logix Super Admin';

  if (!emails.length || !password) {
    throw new Error(
      'SUPER_ADMIN_EMAIL or SUPER_ADMIN_EMAILS and SUPER_ADMIN_PASSWORD are required to seed the backend-only SUPER_ADMIN account.',
    );
  }

  const passwordHash = await hash(password, 10);
  const now = new Date();

  await prisma.$connect();

  for (const email of emails) {
    const user = await prisma.user.upsert({
      where: { email },
      update: {
        fullName,
        passwordHash,
        platformRole: PlatformRole.SUPER_ADMIN,
        status: UserStatus.ACTIVE,
        emailVerifiedAt: now,
        approvedAt: now,
        rejectedAt: null,
        rejectedReason: null,
        loginOtpHash: null,
        loginOtpExpiresAt: null,
        loginOtpRequestedAt: null,
        verificationToken: null,
        verificationTokenExpiresAt: null,
      },
      create: {
        fullName,
        email,
        passwordHash,
        platformRole: PlatformRole.SUPER_ADMIN,
        status: UserStatus.ACTIVE,
        emailVerifiedAt: now,
        approvedAt: now,
      },
    });

    console.log(`SUPER_ADMIN ready: ${user.email}`);
  }

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
});
