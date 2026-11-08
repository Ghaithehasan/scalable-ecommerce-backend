import { ValidationError, ValidationPipe } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';

/** Flattens nested validation errors into one readable list. */
function collectMessages(errors: ValidationError[], path = ''): string[] {
  return errors.flatMap((error) => {
    const field = path ? `${path}.${error.property}` : error.property;
    const own = Object.values(error.constraints ?? {}).map(
      (message) => `${field}: ${message}`,
    );
    const nested = error.children?.length
      ? collectMessages(error.children, field)
      : [];
    return [...own, ...nested];
  });
}

/**
 * The default ValidationPipe throws an HTTP BadRequestException, which the
 * gRPC transport cannot interpret and reports as UNKNOWN (code 2). Converting
 * it here gives the caller INVALID_ARGUMENT (code 3) with the exact fields
 * that failed.
 */
export function createGrpcValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: (errors: ValidationError[]) =>
      new RpcException({
        code: status.INVALID_ARGUMENT,
        message: collectMessages(errors).join('; ') || 'Invalid request',
      }),
  });
}
