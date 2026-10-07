export type JwtPayload = {
  sub: string;
  email: string;
  platformRole: string | null;
  membershipRoles: string[];
  organizationIds: string[];
  memberships: {
    organizationId: string;
    role: string;
    sectionAccess?: unknown;
    /** Organization status at request time (filled from the DB by JwtStrategy). */
    organizationStatus?: string;
  }[];
  /** Token type. Access tokens carry 'access'; tracking socket tokens carry 'tracking'. */
  typ?: string;
  /** Password fingerprint; tokens are rejected once the password changes. */
  pwv?: string;
  iat?: number;
  exp?: number;
  /**
   * Set by JwtStrategy when every membership belongs to an organization that
   * is still pending approval: only onboarding endpoints are reachable.
   * Never stored in a token.
   */
  onboardingOnly?: boolean;
  /** Set by RolesGuard for the current request; it is never stored in a token. */
  requestedSection?: string;
};
