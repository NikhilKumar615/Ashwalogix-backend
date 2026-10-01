import type { ConfigService } from '@nestjs/config';

const LOCAL_ORIGINS = ['http://localhost:5173', 'http://localhost:8081'];

export function allowedOrigins(rawValue = process.env.CORS_ALLOWED_ORIGINS) {
  const configured = (rawValue ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  return configured.length ? configured : LOCAL_ORIGINS;
}

export function jwtSecret(configService: ConfigService) {
  const secret = configService.get<string>('JWT_SECRET')?.trim();

  if (secret && secret !== 'replace-with-a-long-random-secret') {
    return secret;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET must be configured with a strong value in production');
  }

  return 'dev-secret';
}

export function validateProductionSecurityConfig() {
  if (process.env.NODE_ENV !== 'production') {
    return;
  }

  if (!process.env.CORS_ALLOWED_ORIGINS?.trim()) {
    throw new Error('CORS_ALLOWED_ORIGINS must be configured in production');
  }

  if (
    !process.env.JWT_SECRET?.trim() ||
    process.env.JWT_SECRET === 'replace-with-a-long-random-secret'
  ) {
    throw new Error('JWT_SECRET must be configured with a strong value in production');
  }
}
