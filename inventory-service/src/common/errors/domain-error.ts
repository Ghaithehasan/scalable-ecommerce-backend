import { status } from '@grpc/grpc-js';

/**
 * An error the caller is allowed to see.
 *
 * Domain errors carry the gRPC status code that describes them, so the
 * exception filter can translate them without a lookup table. Anything that is
 * NOT a DomainError is treated as a bug and reported as INTERNAL with its
 * details kept on the server.
 *
 * Note what is deliberately absent: "not enough stock" is not an error here.
 * It is a normal business outcome and travels back inside ReserveStockResponse
 * as `reserved = false` plus the shortages, so the caller can tell a failed
 * call apart from a refused one.
 */
export class DomainError extends Error {
  constructor(
    readonly code: status,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Malformed request: missing id, empty items, non-positive or duplicate. */
export class InvalidArgumentError extends DomainError {
  constructor(message: string) {
    super(status.INVALID_ARGUMENT, message);
  }
}

/** A product id the inventory service does not stock. */
export class ProductNotFoundError extends DomainError {
  constructor(productId: string) {
    super(status.NOT_FOUND, `Unknown product "${productId}"`);
  }
}

/**
 * ReserveStock arrived for a reservation that was already released. This is
 * the late-reserve case: the caller timed out, compensated with a release, and
 * the original reserve then reached the server. Re-reserving would silently
 * take stock nobody is waiting for.
 */
export class ReservationAlreadyReleasedError extends DomainError {
  constructor(reservationId: string) {
    super(
      status.FAILED_PRECONDITION,
      `Reservation "${reservationId}" has already been released and cannot be reserved again`,
    );
  }
}

/** Placeholder for handlers that phase 3 fills in. */
export class NotImplementedYetError extends DomainError {
  constructor(operation: string) {
    super(status.UNIMPLEMENTED, `${operation} is not implemented yet`);
  }
}
