import type { ConfigService } from '@nestjs/config';

const LOCAL_ORIGINS = ['http://localhost:5173', 'http://localhost:8081'];
const PLACEHOLDER_JWT_SECRET = 'replace-with-a-long-random-secret';
const DEV_ONLY_JWT_SECRET = 'dev-only-insecure-jwt-secret';
const MIN_JWT_SECRET_LENGTH = 32;

export function isProduction() {
  return process.env.NODE_ENV === 'production';
}

export function allowedOrigins(rawValue = process.env.CORS_ALLOWED_ORIGINS) {
  const configured = (rawValue ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  return configured.length ? configured : LOCAL_ORIGINS;
}

/**
 * The dev fallback secret is only allowed when the developer explicitly opts in
 * with NODE_ENV=development AND ALLOW_DEV_JWT_SECRET=true. Every other
 * environment (including an unset NODE_ENV) fails closed.
 */
function devJwtSecretAllowed() {
  return (
    process.env.NODE_ENV === 'development' &&
    String(process.env.ALLOW_DEV_JWT_SECRET ?? '').toLowerCase() === 'true'
  );
}

function resolveJwtSecret(rawSecret: string | undefined) {
  const secret = rawSecret?.trim();

  if (secret && secret !== PLACEHOLDER_JWT_SECRET) {
    if (isProduction() && secret.length < MIN_JWT_SECRET_LENGTH) {
      throw new Error(
        `JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters in production`,
      );
    }
    return secret;
  }

  if (devJwtSecretAllowed()) {
    return DEV_ONLY_JWT_SECRET;
  }

  throw new Error(
    'JWT_SECRET must be configured with a strong random value. ' +
      '(For local development only, set NODE_ENV=development and ALLOW_DEV_JWT_SECRET=true.)',
  );
}

export function jwtSecret(configService: ConfigService) {
  return resolveJwtSecret(
    configService.get<string>('JWT_SECRET') ?? process.env.JWT_SECRET,
  );
}

/**
 * Whether one-time secrets (password reset tokens, OTPs) may be echoed back in
 * API responses for local testing. Never true in production, and off unless
 * AUTH_EXPOSE_EMAIL_TOKENS=true is explicitly set.
 */
export function shouldExposeEmailTokens(rawValue?: string) {
  if (isProduction()) {
    return false;
  }

  return (
    String(rawValue ?? 'false')
      .trim()
      .toLowerCase() === 'true'
  );
}

export function swaggerEnabled() {
  const flag = process.env.SWAGGER_ENABLED?.trim().toLowerCase();
  if (flag === 'true') return true;
  if (flag === 'false') return false;
  return !isProduction();
}

export function validateProductionSecurityConfig() {
  // Fail fast in every environment if the JWT secret is unusable.
  resolveJwtSecret(process.env.JWT_SECRET);

  if (!isProduction()) {
    return;
  }

  if (!process.env.CORS_ALLOWED_ORIGINS?.trim()) {
    throw new Error('CORS_ALLOWED_ORIGINS must be configured in production');
  }
}
