import { ForbiddenException } from '@nestjs/common';
import type { UserResponseDto } from '../../users/dto/user-response.dto';
import { UserRole } from '../../users/enums/user-role.enum';

/**
 * Ownership rules shared by every resource that belongs to a user.
 *
 * Keeping them here, instead of repeating role comparisons inside each
 * controller, gives the project a single place to change when access control
 * grows (for example when records become scoped to an organisation as well as
 * to a user).
 */

/** A RESPONSIBLE user administers the shop and is not limited to own records. */
export function isPrivileged(currentUser: UserResponseDto): boolean {
  return currentUser.role === UserRole.RESPONSIBLE;
}

/** Rejects a read or write on a record owned by somebody else. */
export function assertOwnership(
  currentUser: UserResponseDto,
  ownerId: number,
  resourceName: string,
): void {
  if (isPrivileged(currentUser) || currentUser.id === ownerId) {
    return;
  }

  throw new ForbiddenException(
    `You cannot access ${resourceName} belonging to another user`,
  );
}

/**
 * Resolves the owner filter for a list endpoint.
 *
 * A customer is always restricted to their own records, so asking for another
 * user's data is refused instead of silently returning an empty page. A
 * RESPONSIBLE user reads every record and may narrow the list with
 * `requestedOwnerId`; `undefined` then means "no owner filter".
 */
export function resolveOwnerFilter(
  currentUser: UserResponseDto,
  requestedOwnerId: number | undefined,
  resourceName: string,
): number | undefined {
  if (isPrivileged(currentUser)) {
    return requestedOwnerId;
  }

  if (requestedOwnerId !== undefined && requestedOwnerId !== currentUser.id) {
    throw new ForbiddenException(
      `You cannot list ${resourceName} belonging to another user`,
    );
  }

  return currentUser.id;
}
