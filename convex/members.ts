import { mutationGeneric as mutation, queryGeneric as query } from "convex/server";
import { ConvexError, v } from "convex/values";
import { normalizeEmail, normalizePersonName } from "./email";
import { canAccessHub, normalizeDesignation } from "./hubAccess";

/** Normalize ITS for lookup/storage: digits only (matches spreadsheet itsId imports). */
function normalizeIts(raw: string): string {
  return String(raw ?? "").replace(/\D/g, "");
}

function optionalTrim(raw: string | undefined): string | undefined {
  const t = String(raw ?? "").trim();
  return t || undefined;
}

/**
 * Lookup a member by their ITS number.
 * Returns the member object if found, null otherwise.
 */
export const login = mutation({
  args: { its_number: v.string() },
  handler: async (ctx, args) => {
    const its_number = normalizeIts(args.its_number);
    if (!its_number) {
      return null;
    }

    const member = await ctx.db
      .query("members")
      .withIndex("by_its_number", (q) => q.eq("its_number", its_number))
      .unique();

    if (!member) {
      return null;
    }

    const isPoc =
      normalizeDesignation(member.designation)?.toLowerCase() === "coordinator";

    return {
      _id: member._id,
      name: member.name,
      its_number: member.its_number,
      email: member.email,
      designation: member.designation,
      jamaat: member.jamaat,
      coordinator: member.coordinator,
      can_access_hub: canAccessHub(member.designation),
      is_poc: isPoc,
    };
  },
});

const memberRow = v.object({
  its_number: v.string(),
  name: v.string(),
  email: v.optional(v.string()),
  designation: v.optional(v.string()),
  jamaat: v.optional(v.string()),
  coordinator: v.optional(v.string()),
});

/**
 * Bulk upsert members (e.g. from spreadsheet import). Protected by `MEMBERS_IMPORT_SECRET`
 * on this Convex deployment (set in Dashboard → Settings → Environment Variables).
 *
 * Run against the **member** deployment URL (`VITE_CONVEX_URL_MEMBER`) so data lives where the portal authenticates.
 */
export const importMembersBulk = mutation({
  args: {
    secret: v.string(),
    rows: v.array(memberRow),
  },
  handler: async (ctx, args) => {
    const expected = process.env.MEMBERS_IMPORT_SECRET;
    if (!expected || args.secret !== expected) {
      throw new ConvexError("Unauthorized");
    }

    let inserted = 0;
    let updated = 0;
    const now = Date.now();

    for (const row of args.rows) {
      const its_number = normalizeIts(row.its_number);
      if (!its_number) continue;

      const name = row.name.trim();
      if (!name) continue;

      const email = row.email?.trim() ? normalizeEmail(row.email) : undefined;
      const designation = normalizeDesignation(row.designation);
      const jamaat = optionalTrim(row.jamaat);
      const coordinator = optionalTrim(row.coordinator);

      const existing = await ctx.db
        .query("members")
        .withIndex("by_its_number", (q) => q.eq("its_number", its_number))
        .unique();

      if (existing) {
        await ctx.db.patch(existing._id, {
          name,
          email,
          designation,
          jamaat,
          coordinator,
        });
        updated += 1;
      } else {
        await ctx.db.insert("members", {
          its_number,
          name,
          email,
          designation,
          jamaat,
          coordinator,
          created_at: now,
        });
        inserted += 1;
      }
    }

    return { inserted, updated, total: inserted + updated };
  },
});

/**
 * After a full roster import, delete members whose ITS is not in `keepItsNumbers`.
 * Protected by the same `MEMBERS_IMPORT_SECRET` as bulk import.
 */
export const pruneMembersNotInSet = mutation({
  args: {
    secret: v.string(),
    keepItsNumbers: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const expected = process.env.MEMBERS_IMPORT_SECRET;
    if (!expected || args.secret !== expected) {
      throw new ConvexError("Unauthorized");
    }

    const keep = new Set(
      args.keepItsNumbers.map((n) => normalizeIts(n)).filter(Boolean),
    );

    let deleted = 0;
    const all = await ctx.db.query("members").collect();
    for (const m of all) {
      if (!keep.has(m.its_number)) {
        await ctx.db.delete(m._id);
        deleted += 1;
      }
    }

    return { deleted, kept: keep.size };
  },
});

export const getById = query({
  args: { memberId: v.id("members") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.memberId);
  },
});

/**
 * Server-to-server: admin deployment calls this on the **member** deployment via
 * `surveyRosterBridge.fetchMemberRosterByEmails`. Protected by `MEMBER_ROSTER_BRIDGE_SECRET`
 * on **this** deployment (same value as on admin).
 */
export const batchLookupByEmailsForBridge = query({
  args: {
    emails: v.array(v.string()),
    bridgeSecret: v.string(),
  },
  handler: async (ctx, { emails, bridgeSecret }) => {
    const expected = process.env.MEMBER_ROSTER_BRIDGE_SECRET;
    if (!expected || bridgeSecret !== expected) {
      throw new ConvexError("Unauthorized");
    }
    const MAX = 200;
    if (emails.length > MAX) {
      throw new ConvexError(`At most ${MAX} emails per request`);
    }

    const want = new Set<string>();
    for (const e of emails) {
      const t = e.trim();
      if (t) want.add(normalizeEmail(t));
    }

    const out: Record<string, { its_number: string; name: string }> = {};
    if (want.size === 0) return out;

    const membersList = await ctx.db.query("members").collect();
    for (const m of membersList) {
      if (!m.email?.trim()) continue;
      const k = normalizeEmail(m.email);
      if (!want.has(k)) continue;
      if (!out[k]) {
        out[k] = { its_number: m.its_number, name: m.name };
      }
    }
    return out;
  },
});

/**
 * Member deployment only: called from **admin** `hub.logContribution` action via HTTP
 * when admin `members` has no row for this ITS (lazy roster sync).
 * Same secret as `batchLookupByEmailsForBridge` (`MEMBER_ROSTER_BRIDGE_SECRET`).
 */
export const lookupByItsForHubBridge = query({
  args: {
    its_number: v.string(),
    bridgeSecret: v.string(),
  },
  handler: async (ctx, { its_number, bridgeSecret }) => {
    const expected = process.env.MEMBER_ROSTER_BRIDGE_SECRET;
    if (!expected || bridgeSecret !== expected) {
      throw new ConvexError("Unauthorized");
    }

    const its = normalizeIts(its_number);
    if (!its) {
      return null;
    }

    const member = await ctx.db
      .query("members")
      .withIndex("by_its_number", (q) => q.eq("its_number", its))
      .unique();

    if (!member) {
      return null;
    }

    return {
      name: member.name,
      email: member.email,
      designation: member.designation,
      jamaat: member.jamaat,
      coordinator: member.coordinator,
      can_access_hub: canAccessHub(member.designation),
    };
  },
});

/**
 * Same-jamaat roster for chapter secretaries logging leadership hub pledges.
 * Used by admin `hub.jamaatRosterForLogging` via HTTP bridge.
 */
export const jamaatRosterForItsBridge = query({
  args: {
    its_number: v.string(),
    bridgeSecret: v.string(),
  },
  handler: async (ctx, { its_number, bridgeSecret }) => {
    const expected = process.env.MEMBER_ROSTER_BRIDGE_SECRET;
    if (!expected || bridgeSecret !== expected) {
      throw new ConvexError("Unauthorized");
    }

    const its = normalizeIts(its_number);
    if (!its) return null;

    const self = await ctx.db
      .query("members")
      .withIndex("by_its_number", (q) => q.eq("its_number", its))
      .unique();

    if (!self) return null;

    const jamaat = (self.jamaat ?? "").trim();
    if (!jamaat) {
      return {
        jamaat: null as string | null,
        logger: {
          its_number: self.its_number,
          name: self.name,
          designation: self.designation,
          jamaat: self.jamaat,
          email: self.email,
          coordinator: self.coordinator,
          can_access_hub: canAccessHub(self.designation),
        },
        members: [] as {
          its_number: string;
          name: string;
          designation?: string;
          email?: string;
        }[],
      };
    }

    const peers = await ctx.db
      .query("members")
      .withIndex("by_jamaat", (q) => q.eq("jamaat", jamaat))
      .collect();

    const members = peers
      .map((m) => ({
        its_number: m.its_number,
        name: m.name,
        designation: m.designation,
        email: m.email,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      jamaat,
      logger: {
        its_number: self.its_number,
        name: self.name,
        designation: self.designation,
        jamaat: self.jamaat,
        email: self.email,
        coordinator: self.coordinator,
        can_access_hub: canAccessHub(self.designation),
      },
      members,
    };
  },
});

/**
 * POC (Coordinator) roster scope: jamaats + members under this coordinator's name.
 * Used by admin `hub.pocNiyyatTotals` via HTTP bridge.
 */
export const pocScopeForItsBridge = query({
  args: {
    its_number: v.string(),
    bridgeSecret: v.string(),
  },
  handler: async (ctx, { its_number, bridgeSecret }) => {
    const expected = process.env.MEMBER_ROSTER_BRIDGE_SECRET;
    if (!expected || bridgeSecret !== expected) {
      throw new ConvexError("Unauthorized");
    }

    const its = normalizeIts(its_number);
    if (!its) return null;

    const self = await ctx.db
      .query("members")
      .withIndex("by_its_number", (q) => q.eq("its_number", its))
      .unique();

    if (!self) return null;

    const isPoc =
      normalizeDesignation(self.designation)?.toLowerCase() === "coordinator";
    if (!isPoc) {
      return { is_poc: false as const };
    }

    const selfKey = normalizePersonName(self.name);
    const all = await ctx.db.query("members").collect();
    const byJamaat: Record<
      string,
      { its_number: string; name: string; designation?: string }[]
    > = {};

    for (const m of all) {
      if (normalizePersonName(m.coordinator) !== selfKey) continue;
      const jamaat = (m.jamaat ?? "Unassigned").trim() || "Unassigned";
      if (!byJamaat[jamaat]) byJamaat[jamaat] = [];
      byJamaat[jamaat].push({
        its_number: m.its_number,
        name: m.name,
        designation: m.designation,
      });
    }

    return {
      is_poc: true as const,
      coordinator_name: self.name,
      by_jamaat: byJamaat,
    };
  },
});
