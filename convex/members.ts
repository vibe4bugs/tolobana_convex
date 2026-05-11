import { mutationGeneric as mutation, queryGeneric as query } from "convex/server";
import { ConvexError, v } from "convex/values";
import { normalizeEmail } from "./email";

/** Normalize ITS for lookup/storage: digits only (matches spreadsheet itsId imports). */
function normalizeIts(raw: string): string {
  return String(raw ?? "").replace(/\D/g, "");
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

    return {
      _id: member._id,
      name: member.name,
      its_number: member.its_number,
      email: member.email,
    };
  },
});

const memberRow = v.object({
  its_number: v.string(),
  name: v.string(),
  email: v.optional(v.string()),
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

      const existing = await ctx.db
        .query("members")
        .withIndex("by_its_number", (q) => q.eq("its_number", its_number))
        .unique();

      if (existing) {
        await ctx.db.patch(existing._id, {
          name,
          email,
        });
        updated += 1;
      } else {
        await ctx.db.insert("members", {
          its_number,
          name,
          email,
          created_at: now,
        });
        inserted += 1;
      }
    }

    return { inserted, updated, total: inserted + updated };
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
