import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sign } from 'jsonwebtoken';
import type { TrackingRole } from '../src/modules/tracking/interfaces/tracking-token-payload.interface';

type Arguments = Record<string, string>;

function main() {
  const args = parseArgs(process.argv.slice(2));
  const role = args.role as TrackingRole | undefined;
  const shipmentId = args.shipmentId;
  const organizationId = args.organizationId;
  const subject = args.sub ?? `${role ?? 'client'}-demo`;
  const latitude = Number(args.destinationLat);
  const longitude = Number(args.destinationLng);

  if (
    !role ||
    !shipmentId ||
    !organizationId ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude)
  ) {
    printUsageAndExit();
  }

  const token = sign(
    {
      sub: subject,
      shipmentId,
      organizationId,
      role,
      destination: {
        latitude,
        longitude,
      },
    },
    getJwtSecret(),
    {
      expiresIn: '1d',
    },
  );

  process.stdout.write(`${token}\n`);
}

function parseArgs(entries: string[]) {
  const args: Arguments = {};

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

  const envPath = resolve(process.cwd(), '.env');
  const envContents = readFileSync(envPath, 'utf8');
  const jwtSecretLine = envContents
    .split(/\r?\n/)
    .find((line) => line.startsWith('JWT_SECRET='));

  if (!jwtSecretLine) {
    throw new Error('JWT_SECRET was not found in .env');
  }

  return jwtSecretLine.split('=').slice(1).join('=').replace(/^"|"$/g, '');
}

function printUsageAndExit(): never {
  throw new Error(
    'Usage: npm run tracking:token -- --role rider|customer --shipmentId <id> --organizationId <id> --destinationLat <lat> --destinationLng <lng> [--sub <subject>]',
  );
}

main();
