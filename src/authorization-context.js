const ROLE_ORDER = new Map([
  ["client", 0],
  ["supplier", 1],
  ["rider", 2],
  ["ops_admin", 3],
  ["super_admin", 4],
]);

const contextByUser = new WeakMap();

function roleOrder(left, right) {
  return (ROLE_ORDER.get(left.role) ?? Number.MAX_SAFE_INTEGER)
    - (ROLE_ORDER.get(right.role) ?? Number.MAX_SAFE_INTEGER);
}

/**
 * Resolve the database-owned authorization facts for one Clerk-mapped identity.
 *
 * The legacy users.role column is deliberately absent from this context. It
 * remains on the user object for one release so untouched route code continues
 * to work, but new authorization decisions must use these membership rows.
 */
export function resolveAuthorizationContext(store, user) {
  if (!user) return null;
  const context = {
    user,
    memberships: (store.userRoleMemberships || [])
      .filter((membership) => membership.userId === user.id)
      .sort(roleOrder),
    approvalCases: (store.approvalCases || [])
      .filter((approvalCase) => approvalCase.userId === user.id)
      .sort((left, right) => left.kind.localeCompare(right.kind)),
  };
  contextByUser.set(user, context);
  return context;
}

export function authorizationContextFor(user) {
  return user ? contextByUser.get(user) || null : null;
}

/**
 * Authenticated users with a resolved context authorize only from membership
 * rows. The fallback is solely for untouched internal compatibility consumers
 * that operate on store users outside an HTTP authentication context.
 */
export function identityHasMembership(user, role) {
  const context = authorizationContextFor(user);
  if (context) return context.memberships.some((membership) => membership.role === role);
  return user?.role === role;
}

export function contextHasMembership(context, role) {
  return Boolean(context?.memberships.some((membership) => membership.role === role));
}

export function membershipSummary(membership) {
  return membership ? { role: membership.role } : null;
}

export function approvalCaseSummary(approvalCase) {
  if (!approvalCase) return null;
  return {
    id: approvalCase.id,
    kind: approvalCase.kind,
    status: approvalCase.status,
    version: approvalCase.version,
    applicationRevision: approvalCase.applicationRevision,
    submittedAt: approvalCase.submittedAt ?? null,
    decidedAt: approvalCase.decidedAt ?? null,
    rejectionReason: approvalCase.rejectionReason ?? null,
    suspensionReason: approvalCase.suspensionReason ?? null,
    updatedAt: approvalCase.updatedAt,
  };
}

export function approvalCaseFor(context, kind) {
  return context?.approvalCases.find((approvalCase) => approvalCase.kind === kind) || null;
}

export function membershipFor(context, role) {
  return context?.memberships.find((membership) => membership.role === role) || null;
}
