import { status } from '@grpc/grpc-js';
import { ArgumentsHost, Catch, Logger, RpcExceptionFilter } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { Observable, throwError } from 'rxjs';

import { DomainError } from '../errors/domain-error';

interface GrpcError {
  code: status;
  message: string;
}

/**
 * The single exit point for every failed call.
 *
 * Three cases, in order:
 *   DomainError    a failure the caller is entitled to understand; its own
 *                  status code and message are forwarded as they are.
 *   RpcException   already shaped for gRPC (the validation pipe throws these);
 *                  forwarded unchanged.
 *   anything else  a bug. The full error and stack are logged on the server
 *                  and the caller gets a bare INTERNAL, because stack traces,
 *                  SQL fragments and connection strings must never cross the
 *                  wire.
 */
@Catch()
export class AllRpcExceptionsFilter implements RpcExceptionFilter {
  private readonly logger = new Logger(AllRpcExceptionsFilter.name);

  catch(exception: unknown, _host: ArgumentsHost): Observable<never> {
    return throwError(() => this.toGrpcError(exception));
  }

  private toGrpcError(exception: unknown): GrpcError {
    if (exception instanceof DomainError) {
      return { code: exception.code, message: exception.message };
    }

    if (exception instanceof RpcException) {
      const error = exception.getError();

      if (typeof error === 'string') {
        return { code: status.UNKNOWN, message: error };
      }

      const { code, message } = error as Partial<GrpcError>;
      return {
        code: typeof code === 'number' ? code : status.UNKNOWN,
        message: typeof message === 'string' ? message : 'Request failed',
      };
    }

    this.logger.error(
      'Unhandled error while serving a gRPC call',
      exception instanceof Error ? exception.stack : String(exception),
    );

    return { code: status.INTERNAL, message: 'Internal server error' };
  }
}
