import { status } from '@grpc/grpc-js';
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';

/**
 * One structured line per call: which method, how long it took, and the gRPC
 * status it ended with. Failures are logged at warn level so an operator can
 * see refused and rejected calls without turning on debug logging.
 */
@Injectable()
export class RpcLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('Rpc');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const method = context.getHandler().name;
    const startedAt = process.hrtime.bigint();

    const elapsedMs = (): string =>
      (Number(process.hrtime.bigint() - startedAt) / 1e6).toFixed(1);

    return next.handle().pipe(
      tap({
        next: () => {
          this.logger.log(
            `method=${method} status=OK code=${status.OK} duration_ms=${elapsedMs()}`,
          );
        },
        error: (error: unknown) => {
          const code = this.codeOf(error);
          this.logger.warn(
            `method=${method} status=${status[code] ?? 'UNKNOWN'} code=${code} ` +
              `duration_ms=${elapsedMs()} message="${this.messageOf(error)}"`,
          );
        },
      }),
    );
  }

  private codeOf(error: unknown): status {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      const { code } = error as { code: unknown };
      if (typeof code === 'number') {
        return code;
      }
    }
    return status.UNKNOWN;
  }

  private messageOf(error: unknown): string {
    if (typeof error === 'object' && error !== null && 'message' in error) {
      const { message } = error as { message: unknown };
      if (typeof message === 'string') {
        return message;
      }
    }
    return String(error);
  }
}
