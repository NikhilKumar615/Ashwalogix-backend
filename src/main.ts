import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { FilteredLogger } from './shared/filtered-logger';
import {
  allowedOrigins,
  isProduction,
  swaggerEnabled,
  validateProductionSecurityConfig,
} from './shared/config/runtime-security';

/**
 * TRUST_PROXY controls how many reverse-proxy hops are trusted for the client
 * IP (used by rate limiting). Defaults to 1 in production (typical PaaS load
 * balancer) and off elsewhere so X-Forwarded-For cannot be spoofed locally.
 */
function resolveTrustProxy(): boolean | number | string {
  const raw = process.env.TRUST_PROXY?.trim();
  if (!raw) return isProduction() ? 1 : false;
  if (raw.toLowerCase() === 'true') return true;
  if (raw.toLowerCase() === 'false') return false;
  const hops = Number(raw);
  return Number.isInteger(hops) ? hops : raw;
}

async function bootstrap() {
  validateProductionSecurityConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: new FilteredLogger(),
  });
  app.set('trust proxy', resolveTrustProxy());
  app.disable('x-powered-by');
  app.use(
    helmet({
      // The API serves JSON (and Swagger UI in non-production); a strict CSP
      // would break Swagger's inline assets, so it's only enabled in prod.
      contentSecurityPolicy: isProduction() ? undefined : false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );
  app.setGlobalPrefix('api');
  app.enableCors({
    origin: allowedOrigins(),
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  if (swaggerEnabled()) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Ashwa Logix Backend API')
      .setDescription(
        'Core logistics APIs for shipments, tracking, POD, and documents.',
      )
      .setVersion('1.0.0')
      .addBearerAuth()
      .build();

    const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('docs', app, swaggerDocument);
  } else {
    new Logger('Bootstrap').log(
      'Swagger UI disabled (set SWAGGER_ENABLED=true to enable).',
    );
  }

  const port = process.env.PORT || 3000;
  await app.listen(port);
}
void bootstrap();
