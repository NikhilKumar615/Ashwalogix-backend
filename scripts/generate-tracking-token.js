"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const jsonwebtoken_1 = require("jsonwebtoken");
function main() {
    const args = parseArgs(process.argv.slice(2));
    const role = args.role;
    const shipmentId = args.shipmentId;
    const organizationId = args.organizationId;
    const subject = args.sub ?? `${role ?? 'client'}-demo`;
    const latitude = Number(args.destinationLat);
    const longitude = Number(args.destinationLng);
    if (!role ||
        !shipmentId ||
        !organizationId ||
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude)) {
        printUsageAndExit();
    }
    const token = (0, jsonwebtoken_1.sign)({
        sub: subject,
        shipmentId,
        organizationId,
        role,
        destination: {
            latitude,
            longitude,
        },
    }, getJwtSecret(), {
        expiresIn: '1d',
    });
    process.stdout.write(`${token}\n`);
}
function parseArgs(entries) {
    const args = {};
    for (let index = 0; index < entries.length; index += 1) {
        const current = entries[index];
        if (!current.startsWith('--')) {
            continue;
        }
        const key = current.slice(2);
        const value = entries[index + 1];
        if (!value || value.startsWith('--')) {
            continue;
        }
        args[key] = value;
    }
    return args;
}
function getJwtSecret() {
    if (process.env.JWT_SECRET) {
        return process.env.JWT_SECRET;
    }
    const envPath = (0, node_path_1.resolve)(process.cwd(), '.env');
    const envContents = (0, node_fs_1.readFileSync)(envPath, 'utf8');
    const jwtSecretLine = envContents
        .split(/\r?\n/)
        .find((line) => line.startsWith('JWT_SECRET='));
    if (!jwtSecretLine) {
        throw new Error('JWT_SECRET was not found in .env');
    }
    return jwtSecretLine.split('=').slice(1).join('=').replace(/^"|"$/g, '');
}
function printUsageAndExit() {
    throw new Error('Usage: npm run tracking:token -- --role rider|customer --shipmentId <id> --organizationId <id> --destinationLat <lat> --destinationLng <lng> [--sub <subject>]');
}
main();
//# sourceMappingURL=generate-tracking-token.js.map