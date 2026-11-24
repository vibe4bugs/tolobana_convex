/**
 * Leadership designations from the TKMI roster.
 * Used when a hub collection's `member_portal_audience` is `"leadership"`.
 * Collections set to `"all_members"` are visible to every signed-in member.
 */
const LEADERSHIP_DESIGNATIONS = new Set(
  [
    "Treasurer",
    "Secretary",
    "Joint Secretary",
    "Joint Treasurer",
    "Coordinator",
    "Patron",
    "Management Member",
  ].map((d) => d.toLowerCase()),
);

export const memberPortalAudience = ["all_members", "leadership"] as const;
export type MemberPortalAudience = (typeof memberPortalAudience)[number];

/** Normalize designation for storage / comparison. */
export function normalizeDesignation(raw: string | undefined | null): string | undefined {
  const t = String(raw ?? "").trim();
  return t || undefined;
}

/**
 * What a signed-in designation is allowed to do, beyond viewing campaigns.
 * Secretary and Joint Secretary share the same actions.
 */
const ROLE_ACTIONS = {
  secretary: ["log_chapter_pledges"],
  "joint secretary": ["log_chapter_pledges"],
  coordinator: ["poc_niyyat"],
} as const;

type MappedRole = keyof typeof ROLE_ACTIONS;
type RoleAction = (typeof ROLE_ACTIONS)[MappedRole][number];

function actionsForDesignation(
  designation: string | undefined | null,
): readonly RoleAction[] {
  const key = normalizeDesignation(designation)?.toLowerCase();
  if (!key || !(key in ROLE_ACTIONS)) return [];
  return ROLE_ACTIONS[key as MappedRole];
}

export function canLogChapterPledges(
  designation: string | undefined | null,
): boolean {
  return actionsForDesignation(designation).includes("log_chapter_pledges");
}

export function isCoordinatorDesignation(
  designation: string | undefined | null,
): boolean {
  return actionsForDesignation(designation).includes("poc_niyyat");
}

/** Whether this roster designation counts as leadership for restricted campaigns. */
export function isLeadershipDesignation(
  designation: string | undefined | null,
): boolean {
  const key = normalizeDesignation(designation)?.toLowerCase();
  if (!key) return false;
  return LEADERSHIP_DESIGNATIONS.has(key);
}

/** @deprecated Prefer isLeadershipDesignation — kept for login payload compatibility. */
export function canAccessHub(designation: string | undefined | null): boolean {
  return isLeadershipDesignation(designation);
}

/** Effective audience when the field is missing on older rows. */
export function resolveMemberPortalAudience(
  raw: string | undefined | null,
): MemberPortalAudience {
  return raw === "all_members" ? "all_members" : "leadership";
}

/** Whether a signed-in member may see / contribute to this collection in the portal. */
export function canViewHubCollection(
  audience: string | undefined | null,
  designation: string | undefined | null,
): boolean {
  if (resolveMemberPortalAudience(audience) === "all_members") {
    return true;
  }
  return isLeadershipDesignation(designation);
}
