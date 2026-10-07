import { OrganizationRole, Prisma } from '@prisma/client';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';

/** JWT `typ` claim values. Access tokens authenticate HTTP APIs; tracking tokens only the /tracking socket. */
export const ACCESS_TOKEN_TYPE = 'access';
export const TRACKING_TOKEN_TYPE = 'tracking';

/**
 * Safe projection of a User row. Never select passwordHash, reset/verification
 * tokens or OTP hashes into API responses — use this in every `include`.
 */
export const SAFE_USER_SELECT = {
  id: true,
  fullName: true,
  email: true,
  phone: true,
  platformRole: true,
  status: true,
  emailVerifiedAt: true,
  emailVerificationSuspendedAt: true,
  approvedAt: true,
  rejectedAt: true,
  rejectedReason: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

export const SAFE_USER_WITH_DRIVER_SELECT = {
  ...SAFE_USER_SELECT,
  driverProfile: true,
} satisfies Prisma.UserSelect;

/** One-time tokens (email verification, password reset) are random and stored only as SHA-256. */
export function generateOneTimeToken() {
  return randomBytes(32).toString('base64url');
}

export function hashOneTimeToken(token: string) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

const LEGACY_UUID_TOKEN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Candidate stored values for an incoming token. New tokens are stored hashed;
 * tokens issued before hashing was introduced were plaintext UUIDs. A UUID can
 * never equal a 64-hex hash, so a leaked hash cannot be replayed as a token.
 */
export function oneTimeTokenLookupValues(token: string) {
  const trimmed = token.trim();
  const values = [hashOneTimeToken(trimmed)];
  if (LEGACY_UUID_TOKEN.test(trimmed)) {
    values.push(trimmed);
  }
  return values;
}

/**
 * Short keyed fingerprint of the current password hash, embedded in access
 * tokens (`pwv`). Changing/resetting the password changes the fingerprint and
 * so invalidates every previously issued token, without a schema change.
 */
export function passwordFingerprint(
  passwordHash: string | null | undefined,
  secret: string,
) {
  return createHmac('sha256', secret)
    .update(`pwv:${passwordHash ?? ''}`)
    .digest('base64url')
    .slice(0, 22);
}

export function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export type SectionAccessValue = { fullAccess: boolean; sections: string[] };

/**
 * Effective section access for a membership. DRIVER never gets portal
 * sections; ORG_ADMIN is governed by its role (not by sections); everyone
 * else gets exactly what is stored, defaulting to no sections.
 */
export function effectiveSectionAccess(
  role: string,
  stored: unknown,
): SectionAccessValue | null {
  if (role === OrganizationRole.DRIVER) {
    return null;
  }
  if (role === OrganizationRole.ORG_ADMIN) {
    return { fullAccess: true, sections: [] };
  }
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    return { fullAccess: false, sections: [] };
  }
  const value = stored as { fullAccess?: unknown; sections?: unknown };
  return {
    fullAccess: value.fullAccess === true,
    sections: Array.isArray(value.sections)
      ? value.sections.filter((s): s is string => typeof s === 'string')
      : [],
  };
}

/* ------------------------------------------------------------------------ */
/* In-memory brute-force protection (per process).                           */
/* ------------------------------------------------------------------------ */

type AttemptState = {
  failures: number;
  firstFailureAt: number;
  lockedUntil: number;
};

export class AttemptLimiter {
  private readonly attempts = new Map<string, AttemptState>();

  constructor(
    private readonly maxFailures: number,
    private readonly windowMs: number,
    private readonly lockMs: number,
    private readonly maxEntries = 50_000,
  ) {}

  /** Milliseconds remaining on a lockout, or 0 if not locked. */
  lockedFor(key: string) {
    const state = this.attempts.get(key);
    if (!state) return 0;
    const remaining = state.lockedUntil - Date.now();
    return remaining > 0 ? remaining : 0;
  }

  /** Records a failure; returns true if this failure triggered a lockout. */
  recordFailure(key: string) {
    const now = Date.now();
    let state = this.attempts.get(key);
    if (!state || now - state.firstFailureAt > this.windowMs) {
      state = { failures: 0, firstFailureAt: now, lockedUntil: 0 };
    }
    state.failures += 1;
    let locked = false;
    if (state.failures >= this.maxFailures) {
      state.lockedUntil = now + this.lockMs;
      state.failures = 0;
      state.firstFailureAt = now;
      locked = true;
    }
    this.attempts.delete(key);
    this.attempts.set(key, state);
    this.evict();
    return locked;
  }

  reset(key: string) {
    this.attempts.delete(key);
  }

  private evict() {
    while (this.attempts.size > this.maxEntries) {
      const oldest = this.attempts.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.attempts.delete(oldest);
    }
  }
}

/* ------------------------------------------------------------------------ */
/* Short-lived auth snapshot cache used by JwtStrategy.                      */
/* ------------------------------------------------------------------------ */

const sessionCache = new Map<string, { expiresAt: number; value: unknown }>();
const SESSION_CACHE_MAX = 20_000;

export function getCachedSession<T>(userId: string): T | undefined {
  const hit = sessionCache.get(userId);
  if (!hit) return undefined;
  if (hit.expiresAt <= Date.now()) {
    sessionCache.delete(userId);
    return undefined;
  }
  return hit.value as T;
}

export function setCachedSession(
  userId: string,
  value: unknown,
  ttlMs: number,
) {
  if (ttlMs <= 0) return;
  sessionCache.set(userId, { expiresAt: Date.now() + ttlMs, value });
  while (sessionCache.size > SESSION_CACHE_MAX) {
    const oldest = sessionCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    sessionCache.delete(oldest);
  }
}

/** Call after changing a user's password, status, memberships or permissions. */
export function invalidateUserSession(userId: string) {
  sessionCache.delete(userId);
}

/** Call after organization-wide changes (suspend / reactivate / approve). */
export function invalidateAllSessions() {
  sessionCache.clear();
}
