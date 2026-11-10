import { status } from '@grpc/grpc-js';
import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { grpcCode } from './inventory.client';

export function inventoryHttpError(error: unknown): Error {
  const detail =
    error &&
    typeof error === 'object' &&
    'details' in error &&
    typeof error.details === 'string'
      ? error.details
      : 'Inventory rejected the request';
  switch (grpcCode(error)) {
    case status.INVALID_ARGUMENT:
      return new BadRequestException(detail);
    case status.NOT_FOUND:
      return new NotFoundException(detail);
    case status.ALREADY_EXISTS:
    case status.FAILED_PRECONDITION:
      return new ConflictException(detail);
    case status.DEADLINE_EXCEEDED:
    case status.UNAVAILABLE:
    case status.ABORTED:
    case status.CANCELLED:
      return new ServiceUnavailableException(
        'Inventory could not confirm the order. Retry with the same Idempotency-Key to check its outcome.',
      );
    default:
      return new InternalServerErrorException('Inventory operation failed');
  }
}
