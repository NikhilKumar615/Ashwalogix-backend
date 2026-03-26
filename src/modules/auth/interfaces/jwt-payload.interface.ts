export type JwtPayload = {
  sub: string;
  email: string;
  platformRole: string | null;
  membershipRoles: string[];
  organizationIds: string[];
  memberships: {
    organizationId: string;
    role: string;
  }[];
};
