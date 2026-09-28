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
  }[];
  /** Set by RolesGuard for the current request; it is never stored in a token. */
  requestedSection?: string;
};
