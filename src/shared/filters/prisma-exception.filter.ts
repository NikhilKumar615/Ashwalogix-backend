import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { BaseExceptionFilter, HttpAdapterHost } from '@nestjs/core';
import { Prisma } from '@prisma/client';

/**
 * Global exception filter:
 * - Maps well-known Prisma errors to safe HTTP responses
 *   (P2002 -> 409, P2025 -> 404, P2003 -> 409, invalid input -> 400).
 * - Any other non-HTTP error becomes a generic 500 without leaking internals
 *   (stack/DB messages are logged server-side only).
 * - HttpExceptions (and WebSocket contexts) are delegated to Nest's default handling.
 */
@Catch()
export class GlobalExceptionFilter
  extends BaseExceptionFilter
  implements ExceptionFilter
{
  private readonly logger = new Logger('ExceptionFilter');

  constructor(adapterHost: HttpAdapterHost) {
    super(adapterHost.httpAdapter);
  }

  catch(exception: unknown, host: ArgumentsHost) {
    if (host.getType() !== 'http' || exception instanceof HttpException) {
      return super.catch(exception, host);
    }

    const mapped = this.mapPrismaError(exception);
    const response = host.switchToHttp().getResponse<{
      status: (code: number) => { json: (body: unknown) => void };
      headersSent?: boolean;
    }>();

    if (mapped) {
      this.logger.warn(`${mapped.code ?? 'prisma'}: ${mapped.logMessage}`);
      if (!response.headersSent) {
        response.status(mapped.status).json({
          statusCode: mapped.status,
          error: mapped.error,
          message: mapped.message,
        });
      }
      return;
    }

    const err = exception instanceof Error ? exception : null;
    this.logger.error(
      `Unhandled error: ${err?.message ?? String(exception)}`,
      err?.stack,
    );
    if (!response.headersSent) {
      response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        error: 'Internal Server Error',
        message: 'Something went wrong. Please try again later.',
      });
    }
  }

  private mapPrismaError(exception: unknown): {
    status: number;
    error: string;
    message: string;
    code?: string;
    logMessage: string;
  } | null {
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      switch (exception.code) {
        case 'P2002':
          return {
            status: HttpStatus.CONFLICT,
            error: 'Conflict',
            message:
              'A record with the same unique value already exists. Please use a different value or retry.',
            code: exception.code,
            logMessage: `Unique constraint failed on ${JSON.stringify(exception.meta?.target ?? exception.meta?.modelName ?? 'unknown')}`,
          };
        case 'P2025':
        case 'P2001':
        case 'P2015':
        case 'P2018':
          return {
            status: HttpStatus.NOT_FOUND,
            error: 'Not Found',
            message: 'The requested record was not found.',
            code: exception.code,
            logMessage: exception.message,
          };
        case 'P2003':
        case 'P2014':
          return {
            status: HttpStatus.CONFLICT,
            error: 'Conflict',
            message:
              'This operation conflicts with related records. Check linked data and try again.',
            code: exception.code,
            logMessage: exception.message,
          };
        case 'P2000':
        case 'P2005':
        case 'P2006':
        case 'P2007':
        case 'P2011':
        case 'P2012':
        case 'P2013':
        case 'P2019':
        case 'P2020':
        case 'P2023':
          return {
            status: HttpStatus.BAD_REQUEST,
            error: 'Bad Request',
            message: 'The request contains an invalid value.',
            code: exception.code,
            logMessage: exception.message,
          };
        case 'P2034':
          return {
            status: HttpStatus.CONFLICT,
            error: 'Conflict',
            message: 'The record was modified concurrently. Please retry.',
            code: exception.code,
            logMessage: exception.message,
          };
        default:
          return null;
      }
    }

    if (exception instanceof Prisma.PrismaClientValidationError) {
      return {
        status: HttpStatus.BAD_REQUEST,
        error: 'Bad Request',
        message: 'The request contains an invalid value.',
        logMessage: exception.message,
      };
    }

    return null;
  }
}
