// Shared primitives for the policy module.
//
// Kept in its own file so `validate.ts` (which must never import anything with a
// runtime dependency) and `pools.ts` can share the address form without either
// importing the other.

/**
 * A 20-byte hex address. Deliberately case-tolerant on input — the dashboard may
 * hand us an EIP-55 checksummed string — but every comparison in this module
 * lowercases first (see `types.ts`: "Lowercase 0x-prefixed address").
 */
export const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

export function isAddressLike(value: unknown): value is string {
  return typeof value === 'string' && ADDRESS_PATTERN.test(value);
}
