import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

export interface ApiErrorResponse {
  statusCode: number;
  error: string;
  message: string | string[];
  path: string;
  timestamp: string;
}

/** Turns an HttpStatus key such as `NOT_FOUND` into `Not Found`. */
function titleCaseStatus(status: number): string {
  const name = HttpStatus[status] as string | undefined;

  if (!name) {
    return 'Error';
  }

  return name
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Gives every failed request the same JSON shape.
 *
 * The `statusCode`, `error` and `message` fields keep the structure Nest
 * already produced, so existing clients and tests are unaffected; `path` and
 * `timestamp` are added to make responses easier to correlate with logs.
 * Unexpected errors are logged in full and reported as a plain HTTP 500 so no
 * internal detail reaches the client.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    if (!(exception instanceof HttpException)) {
      this.logger.error(
        `Unhandled error on ${request.method} ${request.url}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    const { error, message, extra } = this.describe(exception, status);

    response.status(status).json({
      statusCode: status,
      error,
      message,
      // Context an exception chose to attach, such as the `shortages` list on
      // a refused order. The five standard fields always win, so the shape
      // every client already relies on cannot be overwritten.
      ...extra,
      path: request.url,
      timestamp: new Date().toISOString(),
    });
  }

  private describe(
    exception: unknown,
    status: number,
  ): {
    error: string;
    message: string | string[];
    extra?: Record<string, unknown>;
  } {
    const fallback = {
      error: titleCaseStatus(status),
      message: 'Internal server error',
    };

    if (!(exception instanceof HttpException)) {
      return fallback;
    }

    const body = exception.getResponse();

    if (typeof body === 'string') {
      return { error: fallback.error, message: body };
    }

    const {
      error,
      message,
      statusCode: _statusCode,
      path: _path,
      timestamp: _timestamp,
      ...extra
    } = body as Record<string, unknown>;

    return {
      error: typeof error === 'string' ? error : fallback.error,
      message:
        typeof message === 'string' || Array.isArray(message)
          ? (message as string | string[])
          : exception.message,
      extra: Object.keys(extra).length > 0 ? extra : undefined,
    };
  }
}
