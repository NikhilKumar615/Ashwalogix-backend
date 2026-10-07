import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Global rate limiter for HTTP routes only. WebSocket gateways (tracking,
 * driver-sync) have their own auth and would otherwise break because the
 * default guard expects an HTTP request/response pair.
 */
@Injectable()
export class HttpThrottlerGuard extends ThrottlerGuard {
  protected async shouldSkip(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }
    return super.shouldSkip(context);
  }
}

/** Per-route limits for sensitive endpoints (use with @Throttle). */
export const AUTH_THROTTLE = {
  /** Login / OTP request: 10 per minute per IP. */
  login: { default: { limit: 10, ttl: 60_000 } },
  /** OTP verification: 5 per 5 minutes per IP (plus per-account lockout). */
  otpVerify: { default: { limit: 5, ttl: 5 * 60_000 } },
  /** Forgot password / reset / verify email: 5 per 15 minutes per IP. */
  emailToken: { default: { limit: 5, ttl: 15 * 60_000 } },
  /** Self-registration: 5 per hour per IP. */
  register: { default: { limit: 5, ttl: 60 * 60_000 } },
  /** Logged-in password change: 5 per 15 minutes per IP. */
  changePassword: { default: { limit: 5, ttl: 15 * 60_000 } },
  /** Public (unauthenticated) document uploads: 20 per 10 minutes per IP. */
  publicUpload: { default: { limit: 20, ttl: 10 * 60_000 } },
} as const;
