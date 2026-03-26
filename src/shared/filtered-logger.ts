import { ConsoleLogger, Injectable, LoggerService, LogLevel } from '@nestjs/common';

const ALLOWED_LOG_CONTEXTS = new Set([
  'NestFactory',
  'InstanceLoader',
  'NestApplication',
]);

@Injectable()
export class FilteredLogger extends ConsoleLogger implements LoggerService {
  constructor() {
    super('Bootstrap', {
      logLevels: ['log', 'error', 'warn', 'debug', 'verbose', 'fatal'] as LogLevel[],
    });
  }

  override log(message: unknown, context?: string) {
    if (!context || ALLOWED_LOG_CONTEXTS.has(context)) {
      super.log(message, context);
    }
  }
}
