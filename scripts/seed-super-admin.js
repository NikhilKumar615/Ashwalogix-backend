"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const config_1 = require("@nestjs/config");
const client_1 = require("@prisma/client");
const bcryptjs_1 = require("bcryptjs");
const prisma_service_1 = require("../src/shared/prisma/prisma.service");
async function main() {
    const configService = new config_1.ConfigService();
    const prisma = new prisma_service_1.PrismaService(configService);
    const emails = [
        ...new Set((process.env.SUPER_ADMIN_EMAILS ??
            process.env.SUPER_ADMIN_EMAIL ??
            '')
            .split(',')
            .map((value) => value.trim().toLowerCase())
            .filter(Boolean)),
    ];
    const password = process.env.SUPER_ADMIN_PASSWORD;
    const fullName = process.env.SUPER_ADMIN_NAME ?? 'Ashwa Logix Super Admin';
    if (!emails.length || !password) {
        throw new Error('SUPER_ADMIN_EMAIL or SUPER_ADMIN_EMAILS and SUPER_ADMIN_PASSWORD are required to seed the backend-only SUPER_ADMIN account.');
    }
    const passwordHash = await (0, bcryptjs_1.hash)(password, 10);
    const now = new Date();
    await prisma.$connect();
    for (const email of emails) {
        const user = await prisma.user.upsert({
            where: { email },
            update: {
                fullName,
                passwordHash,
                platformRole: client_1.PlatformRole.SUPER_ADMIN,
                status: client_1.UserStatus.ACTIVE,
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
                platformRole: client_1.PlatformRole.SUPER_ADMIN,
                status: client_1.UserStatus.ACTIVE,
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
//# sourceMappingURL=seed-super-admin.js.map