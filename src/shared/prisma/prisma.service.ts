import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly pool: Pool;

  constructor(configService: ConfigService) {
    const connectionString =
      configService.get<string>('DATABASE_URL') ?? process.env.DATABASE_URL ?? '';
    const databaseSslRejectUnauthorized =
      (configService.get<string>('DATABASE_SSL_REJECT_UNAUTHORIZED') ??
        process.env.DATABASE_SSL_REJECT_UNAUTHORIZED ??
        'false') === 'true';
    const poolMax = Number(
      configService.get<string>('DATABASE_POOL_MAX') ??
        process.env.DATABASE_POOL_MAX ??
        '10',
    );
    const idleTimeoutMillis = Number(
      configService.get<string>('DATABASE_POOL_IDLE_TIMEOUT_MS') ??
        process.env.DATABASE_POOL_IDLE_TIMEOUT_MS ??
        '30000',
    );
    const connectionTimeoutMillis = Number(
      configService.get<string>('DATABASE_POOL_CONNECTION_TIMEOUT_MS') ??
        process.env.DATABASE_POOL_CONNECTION_TIMEOUT_MS ??
        '15000',
    );
    const transactionMaxWait = Number(
      configService.get<string>('DATABASE_TRANSACTION_MAX_WAIT_MS') ??
        process.env.DATABASE_TRANSACTION_MAX_WAIT_MS ??
        '10000',
    );
    const transactionTimeout = Number(
      configService.get<string>('DATABASE_TRANSACTION_TIMEOUT_MS') ??
        process.env.DATABASE_TRANSACTION_TIMEOUT_MS ??
        '30000',
    );

    const pool = new Pool({
      connectionString: sanitizeConnectionString(connectionString),
      max: poolMax,
      idleTimeoutMillis,
      connectionTimeoutMillis,
      ssl: connectionString.includes('sslmode=')
        ? {
            rejectUnauthorized: databaseSslRejectUnauthorized,
          }
        : undefined,
    });

    pool.on('error', (error) => {
      console.error('PostgreSQL pool error', error);
    });

    super({
      adapter: new PrismaPg(pool),
      transactionOptions: {
        maxWait: transactionMaxWait,
        timeout: transactionTimeout,
      },
    });

    this.pool = pool;
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
    await this.pool.end();
  }
}

function sanitizeConnectionString(connectionString: string) {
  if (!connectionString) {
    return connectionString;
  }

  const url = new URL(connectionString);
  url.searchParams.delete('sslmode');
  url.searchParams.delete('sslcert');
  url.searchParams.delete('sslkey');
  url.searchParams.delete('sslrootcert');
  url.searchParams.delete('sslaccept');

  return url.toString();
}
