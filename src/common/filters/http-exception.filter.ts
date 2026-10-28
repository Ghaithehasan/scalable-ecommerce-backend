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

    response.status(status).json({
      statusCode: status,
      ...this.describe(exception, status),
      path: request.url,
      timestamp: new Date().toISOString(),
    });
  }

  private describe(
    exception: unknown,
    status: number,
  ): { error: string; message: string | string[] } {
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

    const { error, message } = body as {
      error?: unknown;
      message?: unknown;
    };

    return {
      error: typeof error === 'string' ? error : fallback.error,
      message:
        typeof message === 'string' || Array.isArray(message)
          ? (message as string | string[])
          : exception.message,
    };
  }
}
