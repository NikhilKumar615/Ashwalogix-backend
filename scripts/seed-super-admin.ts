import 'dotenv/config';
import { ConfigService } from '@nestjs/config';
import { PlatformRole, UserStatus } from '@prisma/client';
import { hash } from 'bcryptjs';
import { PrismaService } from '../src/shared/prisma/prisma.service';

async function main() {
  const configService = new ConfigService();
  const prisma = new PrismaService(configService);

  const email = process.env.SUPER_ADMIN_EMAIL?.toLowerCase();
  const password = process.env.SUPER_ADMIN_PASSWORD;
  const fullName = process.env.SUPER_ADMIN_NAME ?? 'Ashwa Logix Super Admin';

  if (!email || !password) {
    throw new Error(
      'SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD are required to seed the backend-only SUPER_ADMIN account.',
    );
  }

  const passwordHash = await hash(password, 10);
  const now = new Date();

  await prisma.$connect();

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
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
});
