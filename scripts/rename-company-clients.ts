import 'reflect-metadata';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { Pool } from 'pg';

loadDotEnv();

function loadDotEnv() {
  const envPath = resolve(process.cwd(), '.env');

  if (!existsSync(envPath)) {
    return;
  }

  const lines = readFileSync(envPath, 'utf8').split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');

    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

async function main() {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error('DATABASE_URL is required');
  }

  const rejectUnauthorized =
    (process.env.DATABASE_SSL_REJECT_UNAUTHORIZED ?? 'false').toLowerCase() ===
    'true';

  const pool = new Pool({
    connectionString: sanitizeConnectionString(connectionString),
    ssl: connectionString.includes('sslmode=')
      ? {
          rejectUnauthorized,
        }
      : undefined,
  });

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    await client.query(`
      ALTER TABLE IF EXISTS clients RENAME TO company_clients;
      ALTER TABLE IF EXISTS client_locations RENAME TO company_client_locations;
    `);

    await client.query(`
      ALTER TABLE company_clients
        RENAME COLUMN client_code TO company_client_code;
    `);

    await client.query(`
      ALTER TABLE company_client_locations
        RENAME COLUMN client_id TO company_client_id;
    `);

    await client.query(`
      ALTER TABLE shipments
        RENAME COLUMN client_id TO company_client_id;
    `);

    await client.query(`
      ALTER INDEX IF EXISTS clients_organization_id_client_code_key
        RENAME TO company_clients_organization_id_company_client_code_key;
      ALTER INDEX IF EXISTS clients_organization_id_idx
        RENAME TO company_clients_organization_id_idx;
      ALTER INDEX IF EXISTS clients_status_idx
        RENAME TO company_clients_status_idx;
      ALTER INDEX IF EXISTS clients_name_idx
        RENAME TO company_clients_name_idx;
      ALTER INDEX IF EXISTS clients_gstin_idx
        RENAME TO company_clients_gstin_idx;
      ALTER INDEX IF EXISTS client_locations_organization_id_idx
        RENAME TO company_client_locations_organization_id_idx;
      ALTER INDEX IF EXISTS client_locations_client_id_idx
        RENAME TO company_client_locations_company_client_id_idx;
      ALTER INDEX IF EXISTS client_locations_client_id_is_primary_idx
        RENAME TO company_client_locations_company_client_id_is_primary_idx;
      ALTER INDEX IF EXISTS shipments_client_id_idx
        RENAME TO shipments_company_client_id_idx;
    `);

    await client.query('COMMIT');
    console.log('Renamed client tables/columns to company_client equivalents.');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

function sanitizeConnectionString(connectionString: string) {
  const url = new URL(connectionString);

  url.searchParams.delete('sslmode');
  url.searchParams.delete('sslcert');
  url.searchParams.delete('sslkey');
  url.searchParams.delete('sslrootcert');
  url.searchParams.delete('sslaccept');

  return url.toString();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
