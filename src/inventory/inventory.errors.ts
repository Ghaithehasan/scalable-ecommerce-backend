import {
  BadRequestException,
  ConflictException,
  HttpException,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { status } from '@grpc/grpc-js';

import type { Shortage } from './generated/inventory/v1/inventory';

/**
 * Translating the warehouse's answers into HTTP.
 *
 * Two kinds of "no" arrive from the inventory service and they must not be
 * confused:
 *
 *   a BUSINESS no  - `reserved = false` with shortages. The call worked; the
 *                    warehouse simply does not have the goods.
 *   a TECHNICAL no - a gRPC status code. Something went wrong, possibly on our
 *                    side, possibly on the network.
 */

export interface ShortageDetail {
  productId: number;
  requested: number;
  available: number;
}

/**
 * HTTP 409: the order cannot be placed because stock is insufficient. The body
 * names every short item so the customer can fix the basket in one go rather
 * than discovering the problem one product at a time.
 */
export class InsufficientStockException extends ConflictException {
  constructor(shortages: Shortage[]) {
    const details: ShortageDetail[] = shortages.map((shortage) => ({
      productId: Number(shortage.productId),
      requested: shortage.requested,
      available: shortage.available,
    }));

    super({
      statusCode: 409,
      error: 'Conflict',
      message: 'Some items are no longer available in the requested quantity',
      shortages: details,
    });
  }
}

/**
 * Maps a gRPC failure onto the HTTP status that describes it to the customer.
 *
 * UNAVAILABLE and DEADLINE_EXCEEDED are the two the requirement cares about:
 * the warehouse is down, or it did not answer in time. Both become 503 with a
 * message that tells the customer to try again rather than leaving them with a
 * spinner or a stack trace.
 */
export function mapGrpcError(error: unknown, operation: string): HttpException {
  const code = grpcCodeOf(error);

  switch (code) {
    case status.NOT_FOUND:
      return new NotFoundException(
        detailsOf(error) || 'A product in this order is unknown to the warehouse',
      );

    case status.INVALID_ARGUMENT:
      return new BadRequestException(detailsOf(error) || 'Invalid request');

    case status.FAILED_PRECONDITION:
      return new ConflictException(
        detailsOf(error) || 'This reservation can no longer be used',
      );

    case status.UNAVAILABLE:
      return new ServiceUnavailableException(
        'The inventory service is unavailable. Your order was not placed; please try again shortly.',
      );

    case status.DEADLINE_EXCEEDED:
      return new ServiceUnavailableException(
        'The inventory service did not respond in time. Your order was not placed; please try again shortly.',
      );

    default:
      // Nothing internal crosses the wire: the real error is logged by the
      // caller, the customer gets a plain message.
      return new InternalServerErrorException(
        `The inventory service failed while handling ${operation}`,
      );
  }
}

export function grpcCodeOf(error: unknown): status | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code } = error as { code: unknown };
    if (typeof code === 'number') {
      return code;
    }
  }
  return undefined;
}

export function isInventoryUnreachable(error: unknown): boolean {
  const code = grpcCodeOf(error);
  return code === status.UNAVAILABLE || code === status.DEADLINE_EXCEEDED;
}

function detailsOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'details' in error) {
    const { details } = error as { details: unknown };
    if (typeof details === 'string') {
      return details;
    }
  }
  return '';
}
