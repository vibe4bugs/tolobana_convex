import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { requireIdentity } from "./auth";
import { canViewHubCollection } from "./hubAccess";
import {
  allocateReferenceCode,
  defaultExpiresAt,
  effectivePaymentStatus,
} from "./zelleConfig";

/** Same normalization as `members.login` / roster import (digits only). */
function normalizeIts(raw: string): string {
  return String(raw ?? "").replace(/\D/g, "");
}

/** Compare money in integer cents to avoid float drift. */
function moneyCents(n: number): number {
  return Math.round(n * 100);
}

/** Unique display names for "who's contributed" chips (includes chapter breakdown). */
function contributorNamesFromRows(
  contributions: {
    member_id: Id<"members">;
    breakdown?: { name: string }[];
  }[],
  nameById: Map<Id<"members">, string>,
): string[] {
  const names = new Set<string>();
  for (const c of contributions) {
    if (c.breakdown && c.breakdown.length > 0) {
      for (const line of c.breakdown) {
        if (line.name.trim()) names.add(line.name.trim());
      }
    } else {
      const n = nameById.get(c.member_id);
      if (n) names.add(n);
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/** Avoid importing `./_generated/api` for the member query (circular with action). */
const lookupByItsForHubBridge = makeFunctionReference(
  "members:lookupByItsForHubBridge",
) as FunctionReference<"query">;

const pocScopeForItsBridge = makeFunctionReference(
  "members:pocScopeForItsBridge",
) as FunctionReference<"query">;

const jamaatRosterForItsBridge = makeFunctionReference(
  "members:jamaatRosterForItsBridge",
) as FunctionReference<"query">;

type HubBridgeProfile = {
  name: string;
  email?: string;
  designation?: string;
  jamaat?: string;
  coordinator?: string;
  can_access_hub?: boolean;
};

function requireMemberRosterClient(): {
  client: ConvexHttpClient;
  bridgeSecret: string;
} {
  const memberUrl = process.env.MEMBER_ROSTER_CONVEX_URL?.trim().replace(/\/$/, "");
  const bridgeSecret = process.env.MEMBER_ROSTER_BRIDGE_SECRET;
  if (!memberUrl || !bridgeSecret) {
    throw new Error(
      "Server configuration incomplete: set MEMBER_ROSTER_CONVEX_URL and MEMBER_ROSTER_BRIDGE_SECRET on this (admin) deployment — same pattern as the survey roster bridge.",
    );
  }
  return { client: new ConvexHttpClient(memberUrl), bridgeSecret };
}

/**
 * List all hub collections (member tooling).
 */
export const listCollections = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("hub_collections").collect();
  },
});

export const listContributions = query({
  args: {},
  handler: async (ctx) => {
    await requireIdentity(ctx);
    return await ctx.db.query("hub_contributions").collect();
  },
});

/** Admin inbox: contributions newest-first with member + collection context. */
export const listContributionsForAdmin = query({
  args: {},
  handler: async (ctx) => {
    await requireIdentity(ctx);
    const rows = await ctx.db.query("hub_contributions").collect();
    rows.sort((a, b) => b.logged_at - a.logged_at);

    const out = [];
    for (const c of rows) {
      const member = await ctx.db.get(c.member_id);
      const collection = await ctx.db.get(c.collection_id);
      const status = effectivePaymentStatus(c);
      out.push({
        ...c,
        status,
        member_name: member?.name ?? "Unknown",
        member_its: member?.its_number ?? "",
        member_email: member?.email,
        member_designation: member?.designation,
        member_jamaat: c.jamaat ?? member?.jamaat,
        collection_title: collection?.title ?? "Unknown collection",
        collection_slug: collection?.slug ?? "",
        desired_memo: collection?.desired_memo ?? "",
        zelle_contact: collection?.zelle_contact ?? "",
      });
    }
    return out;
  },
});

/** @deprecated Prefer zellePayments.markVerified / markRejected. */
export const setContributionPaymentVerified = mutation({
  args: {
    contributionId: v.id("hub_contributions"),
    verified: v.boolean(),
  },
  handler: async (ctx, { contributionId, verified }) => {
    const identity = await requireIdentity(ctx);
    const doc = await ctx.db.get(contributionId);
    if (!doc) throw new Error("Not found");
    if (verified) {
      await ctx.db.patch(contributionId, {
        status: "verified",
        payment_verified: true,
        payment_verified_at: Date.now(),
        verified_by: identity.subject,
        rejection_reason: undefined,
      });
    } else {
      await ctx.db.patch(contributionId, {
        status: "pending_verification",
        payment_verified: false,
        payment_verified_at: undefined,
        verified_by: undefined,
      });
    }
  },
});

export const setContributionReceiptForwarded = mutation({
  args: {
    contributionId: v.id("hub_contributions"),
    forwarded: v.boolean(),
  },
  handler: async (ctx, { contributionId, forwarded }) => {
    await requireIdentity(ctx);
    const doc = await ctx.db.get(contributionId);
    if (!doc) throw new Error("Not found");
    await ctx.db.patch(contributionId, {
      receipt_forwarded_at: forwarded ? Date.now() : undefined,
    });
  },
});

/** Wipe all hub contribution logs (dev/test cleanup). Keeps collections. */
export const clearAllContributions = mutation({
  args: {},
  handler: async (ctx) => {
    await requireIdentity(ctx);
    const rows = await ctx.db.query("hub_contributions").collect();
    for (const row of rows) {
      await ctx.db.delete(row._id);
    }
    return { deleted: rows.length };
  },
});

/** CLI-friendly wipe for local/dev: `npx convex run internal.hub.clearAllContributionsInternal` */
export const clearAllContributionsInternal = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("hub_contributions").collect();
    for (const row of rows) {
      await ctx.db.delete(row._id);
    }
    return { deleted: rows.length };
  },
});

/** Live hub collections with totals for the member portal home list. */
export const listLive = query({
  args: {
    /** Viewer designation from member roster; filters leadership-only campaigns. */
    designation: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const collections = await ctx.db
      .query("hub_collections")
      .filter((q) =>
        q.and(q.eq(q.field("is_live"), true), q.neq(q.field("archived"), true)),
      )
      .collect();

    const results = [];
    for (const collection of collections) {
      if (!canViewHubCollection(collection.member_portal_audience, args.designation)) {
        continue;
      }

      const contributions = await ctx.db
        .query("hub_contributions")
        .withIndex("by_collection", (q) => q.eq("collection_id", collection._id))
        .collect();

      const countable = contributions.filter((c) => {
        const s = effectivePaymentStatus(c);
        return s !== "rejected" && s !== "expired";
      });
      const totalRaised = countable
        .filter((c) => effectivePaymentStatus(c) === "verified")
        .reduce((sum, c) => sum + c.amount, 0);
      const nameById = new Map<Id<"members">, string>();
      for (const c of countable) {
        if (nameById.has(c.member_id)) continue;
        const m = await ctx.db.get(c.member_id);
        if (m) nameById.set(c.member_id, m.name);
      }
      const contributorNames = contributorNamesFromRows(countable, nameById);

      results.push({
        ...collection,
        totalRaised,
        contributorCount: contributorNames.length,
      });
    }

    return results;
  },
});

/** Collection detail by slug for member hub page. */
export const getBySlug = query({
  args: {
    slug: v.string(),
    designation: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const collection = await ctx.db
      .query("hub_collections")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .unique();

    if (!collection || !collection.is_live || collection.archived) {
      return null;
    }

    if (!canViewHubCollection(collection.member_portal_audience, args.designation)) {
      return null;
    }

    const contributions = await ctx.db
      .query("hub_contributions")
      .withIndex("by_collection", (q) => q.eq("collection_id", collection._id))
      .collect();

    const countable = contributions.filter((c) => {
      const s = effectivePaymentStatus(c);
      return s !== "rejected" && s !== "expired";
    });
    const totalRaised = countable
      .filter((c) => effectivePaymentStatus(c) === "verified")
      .reduce((sum, c) => sum + c.amount, 0);

    const nameById = new Map<Id<"members">, string>();
    for (const c of countable) {
      if (nameById.has(c.member_id)) continue;
      const m = await ctx.db.get(c.member_id);
      if (m) nameById.set(c.member_id, m.name);
    }
    const contributorCount = contributorNamesFromRows(countable, nameById).length;

    return {
      ...collection,
      totalRaised,
      contributorCount,
      // Empty for older cached clients that still read `.contributorNames.length`.
      contributorNames: [] as string[],
    };
  },
});

/**
 * Internal: upsert admin `members` by ITS (from member-deployment bridge) and insert contribution.
 * Access is checked against `viewer_designation` (the person submitting the form), so a
 * secretary can log pledges for chapter members who are not themselves leadership.
 */
export const applyLogContribution = internalMutation({
  args: {
    collectionId: v.id("hub_collections"),
    its: v.string(),
    name: v.string(),
    email: v.optional(v.string()),
    designation: v.optional(v.string()),
    jamaat: v.optional(v.string()),
    coordinator: v.optional(v.string()),
    amount: v.number(),
    note: v.optional(v.string()),
    /** Designation of the signed-in logger (access gate). Defaults to pledger designation. */
    viewer_designation: v.optional(v.string()),
    logged_by_its: v.optional(v.string()),
    logged_by_name: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const collection = await ctx.db.get(args.collectionId);
    if (!collection || !collection.is_live || collection.archived) {
      throw new Error("This collection is no longer active.");
    }
    const accessDesignation = args.viewer_designation ?? args.designation;
    if (!canViewHubCollection(collection.member_portal_audience, accessDesignation)) {
      throw new Error(
        "This campaign is not available for your designation. Contact your administrator if you need access.",
      );
    }
    if (args.amount <= 0) {
      throw new Error("Amount must be greater than zero.");
    }

    let member = await ctx.db
      .query("members")
      .withIndex("by_its_number", (q) => q.eq("its_number", args.its))
      .unique();

    const now = Date.now();
    const displayName = args.name.trim() || "Member";

    if (!member) {
      const id = await ctx.db.insert("members", {
        its_number: args.its,
        name: displayName,
        email: args.email,
        designation: args.designation,
        jamaat: args.jamaat,
        coordinator: args.coordinator,
        created_at: now,
      });
      member = await ctx.db.get(id);
      if (!member) {
        throw new Error("Failed to create member row.");
      }
    } else {
      await ctx.db.patch(member._id, {
        name: displayName,
        ...(args.email !== undefined ? { email: args.email } : {}),
        ...(args.designation !== undefined ? { designation: args.designation } : {}),
        ...(args.jamaat !== undefined ? { jamaat: args.jamaat } : {}),
        ...(args.coordinator !== undefined ? { coordinator: args.coordinator } : {}),
      });
      member = (await ctx.db.get(member._id))!;
    }

    const reference_code = await allocateReferenceCode(ctx);
    const contributionId = await ctx.db.insert("hub_contributions", {
      collection_id: args.collectionId,
      member_id: member._id,
      amount: args.amount,
      currency: "USD",
      reference_code,
      status: "pending_payment",
      note: args.note,
      logged_at: now,
      expires_at: defaultExpiresAt(now),
      jamaat: args.jamaat ?? member.jamaat,
      ...(args.logged_by_its
        ? {
            logged_by_its: args.logged_by_its,
            logged_by_name: args.logged_by_name,
          }
        : {}),
    });

    return contributionId;
  },
});

/** Internal: one chapter payment + matching member breakdown. */
export const applyLogChapterPledges = internalMutation({
  args: {
    collectionId: v.id("hub_collections"),
    viewer_designation: v.optional(v.string()),
    /** Secretary / payer profile (attribution + logged_by). */
    logger: v.object({
      its: v.string(),
      name: v.string(),
      email: v.optional(v.string()),
      designation: v.optional(v.string()),
      jamaat: v.optional(v.string()),
      coordinator: v.optional(v.string()),
    }),
    /** Zelle / pledged payment total — must equal sum of entries. */
    pledged_amount: v.number(),
    entries: v.array(
      v.object({
        its: v.string(),
        name: v.string(),
        email: v.optional(v.string()),
        designation: v.optional(v.string()),
        jamaat: v.optional(v.string()),
        coordinator: v.optional(v.string()),
        amount: v.number(),
      }),
    ),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const collection = await ctx.db.get(args.collectionId);
    if (!collection || !collection.is_live || collection.archived) {
      throw new Error("This collection is no longer active.");
    }
    if (
      !canViewHubCollection(collection.member_portal_audience, args.viewer_designation)
    ) {
      throw new Error(
        "This campaign is not available for your designation. Contact your administrator if you need access.",
      );
    }
    if (!Number.isFinite(args.pledged_amount) || args.pledged_amount <= 0) {
      throw new Error("Pledged amount must be greater than zero.");
    }
    if (args.entries.length === 0) {
      throw new Error("Add at least one member amount to log.");
    }

    let breakdownSumCents = 0;
    for (const entry of args.entries) {
      if (entry.amount <= 0) {
        throw new Error("Each breakdown amount must be greater than zero.");
      }
      breakdownSumCents += moneyCents(entry.amount);
    }
    if (breakdownSumCents !== moneyCents(args.pledged_amount)) {
      throw new Error(
        `Member breakdown ($${(breakdownSumCents / 100).toFixed(2)}) must equal the pledged amount ($${args.pledged_amount.toFixed(2)}).`,
      );
    }

    const now = Date.now();

    // Upsert secretary (payer) on admin members.
    let payer = await ctx.db
      .query("members")
      .withIndex("by_its_number", (q) => q.eq("its_number", args.logger.its))
      .unique();

    const payerName = args.logger.name.trim() || "Member";
    if (!payer) {
      const id = await ctx.db.insert("members", {
        its_number: args.logger.its,
        name: payerName,
        email: args.logger.email,
        designation: args.logger.designation,
        jamaat: args.logger.jamaat,
        coordinator: args.logger.coordinator,
        created_at: now,
      });
      payer = await ctx.db.get(id);
      if (!payer) throw new Error("Failed to create member row.");
    } else {
      await ctx.db.patch(payer._id, {
        name: payerName,
        ...(args.logger.email !== undefined ? { email: args.logger.email } : {}),
        ...(args.logger.designation !== undefined
          ? { designation: args.logger.designation }
          : {}),
        ...(args.logger.jamaat !== undefined ? { jamaat: args.logger.jamaat } : {}),
        ...(args.logger.coordinator !== undefined
          ? { coordinator: args.logger.coordinator }
          : {}),
      });
      payer = (await ctx.db.get(payer._id))!;
    }

    // Keep roster snapshots for breakdown members (for email / POC).
    for (const entry of args.entries) {
      let member = await ctx.db
        .query("members")
        .withIndex("by_its_number", (q) => q.eq("its_number", entry.its))
        .unique();
      const displayName = entry.name.trim() || "Member";
      if (!member) {
        await ctx.db.insert("members", {
          its_number: entry.its,
          name: displayName,
          email: entry.email,
          designation: entry.designation,
          jamaat: entry.jamaat,
          coordinator: entry.coordinator,
          created_at: now,
        });
      } else {
        await ctx.db.patch(member._id, {
          name: displayName,
          ...(entry.email !== undefined ? { email: entry.email } : {}),
          ...(entry.designation !== undefined
            ? { designation: entry.designation }
            : {}),
          ...(entry.jamaat !== undefined ? { jamaat: entry.jamaat } : {}),
          ...(entry.coordinator !== undefined
            ? { coordinator: entry.coordinator }
            : {}),
        });
      }
    }

    const breakdown = args.entries.map((e) => ({
      its_number: e.its,
      name: e.name.trim() || "Member",
      email: e.email,
      amount: e.amount,
      jamaat: e.jamaat,
    }));

    const reference_code = await allocateReferenceCode(ctx);
    const contributionId = await ctx.db.insert("hub_contributions", {
      collection_id: args.collectionId,
      member_id: payer._id,
      amount: args.pledged_amount,
      currency: "USD",
      reference_code,
      status: "pending_payment",
      note: args.note,
      logged_at: now,
      expires_at: defaultExpiresAt(now),
      jamaat: args.logger.jamaat ?? payer.jamaat,
      logged_by_its: args.logger.its,
      logged_by_name: payerName,
      breakdown,
    });

    return { count: breakdown.length, id: contributionId };
  },
});

/**
 * Log a hub contribution from the member portal (no Clerk on admin client).
 *
 * Verifies ITS on the **member** Convex deployment, then inserts into
 * `hub_contributions` on this (admin) deployment for admins to review in the UI.
 * No automated emails are sent.
 *
 * For leadership-only campaigns where a secretary logs chapter pledges, use
 * `logChapterPledges` instead.
 */
export const logContribution = action({
  args: {
    collectionId: v.id("hub_collections"),
    its_number: v.string(),
    amount: v.number(),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Id<"hub_contributions">> => {
    const its = normalizeIts(args.its_number);
    if (!its) {
      throw new Error("Invalid ITS number.");
    }
    if (!Number.isFinite(args.amount) || args.amount <= 0) {
      throw new Error("Amount must be greater than zero.");
    }

    const { client, bridgeSecret } = requireMemberRosterClient();
    let profile: HubBridgeProfile | null;
    try {
      profile = (await client.query(lookupByItsForHubBridge, {
        its_number: its,
        bridgeSecret,
      })) as HubBridgeProfile | null;
    } catch (e) {
      console.error("hub.logContribution: member deployment lookup failed", e);
      throw new Error(
        "Could not verify your ITS with the member directory. Try again later or contact support.",
      );
    }

    if (!profile) {
      throw new Error(
        "ITS not recognised — sign in with an ITS that exists on the member roster.",
      );
    }

    return await ctx.runMutation(internal.hub.applyLogContribution, {
      collectionId: args.collectionId,
      its,
      name: profile.name,
      email: profile.email,
      designation: profile.designation,
      jamaat: profile.jamaat,
      coordinator: profile.coordinator,
      amount: args.amount,
      note: args.note,
      viewer_designation: profile.designation,
      logged_by_its: its,
      logged_by_name: profile.name,
    });
  },
});

/**
 * Same-jamaat member list for the signed-in secretary (leadership pledge UI).
 */
export const jamaatRosterForLogging = action({
  args: { its_number: v.string() },
  handler: async (_ctx, args) => {
    const its = normalizeIts(args.its_number);
    if (!its) {
      throw new Error("Invalid ITS number.");
    }

    const { client, bridgeSecret } = requireMemberRosterClient();
    try {
      return await client.query(jamaatRosterForItsBridge, {
        its_number: its,
        bridgeSecret,
      });
    } catch (e) {
      console.error("hub.jamaatRosterForLogging: roster bridge failed", e);
      throw new Error("Could not load your jamaat roster. Try again later.");
    }
  },
});

/**
 * Leadership / chapter secretary: one payment total + member breakdown that must match.
 * Stored as a single `hub_contributions` row (amount = pledged total, breakdown = lines).
 */
export const logChapterPledges = action({
  args: {
    collectionId: v.id("hub_collections"),
    logger_its: v.string(),
    /** Amount the chapter is paying / pledging (Zelle total). */
    pledged_amount: v.number(),
    entries: v.array(
      v.object({
        its_number: v.string(),
        amount: v.number(),
      }),
    ),
    note: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ count: number; id: Id<"hub_contributions"> }> => {
    const loggerIts = normalizeIts(args.logger_its);
    if (!loggerIts) {
      throw new Error("Invalid ITS number.");
    }
    if (!Number.isFinite(args.pledged_amount) || args.pledged_amount <= 0) {
      throw new Error("Pledged amount must be greater than zero.");
    }
    if (args.entries.length === 0) {
      throw new Error("Add at least one member amount to log.");
    }

    let breakdownSumCents = 0;
    for (const raw of args.entries) {
      if (!Number.isFinite(raw.amount) || raw.amount <= 0) {
        throw new Error("Each breakdown amount must be greater than zero.");
      }
      breakdownSumCents += moneyCents(raw.amount);
    }
    if (breakdownSumCents !== moneyCents(args.pledged_amount)) {
      throw new Error(
        `Member breakdown ($${(breakdownSumCents / 100).toFixed(2)}) must equal the pledged amount ($${args.pledged_amount.toFixed(2)}).`,
      );
    }

    const { client, bridgeSecret } = requireMemberRosterClient();

    let logger: HubBridgeProfile | null;
    try {
      logger = (await client.query(lookupByItsForHubBridge, {
        its_number: loggerIts,
        bridgeSecret,
      })) as HubBridgeProfile | null;
    } catch (e) {
      console.error("hub.logChapterPledges: logger lookup failed", e);
      throw new Error(
        "Could not verify your ITS with the member directory. Try again later or contact support.",
      );
    }
    if (!logger) {
      throw new Error(
        "ITS not recognised — sign in with an ITS that exists on the member roster.",
      );
    }

    const resolved: {
      its: string;
      name: string;
      email?: string;
      designation?: string;
      jamaat?: string;
      coordinator?: string;
      amount: number;
    }[] = [];

    for (const raw of args.entries) {
      const its = normalizeIts(raw.its_number);
      if (!its) {
        throw new Error("Each pledge line needs a valid ITS number.");
      }

      let profile: HubBridgeProfile | null;
      try {
        profile = (await client.query(lookupByItsForHubBridge, {
          its_number: its,
          bridgeSecret,
        })) as HubBridgeProfile | null;
      } catch (e) {
        console.error("hub.logChapterPledges: pledger lookup failed", e);
        throw new Error(
          `Could not look up ITS ${its} in the member directory. Try again later.`,
        );
      }
      if (!profile) {
        throw new Error(`ITS ${its} was not found on the member roster.`);
      }

      resolved.push({
        its,
        name: profile.name,
        email: profile.email,
        designation: profile.designation,
        jamaat: profile.jamaat,
        coordinator: profile.coordinator,
        amount: raw.amount,
      });
    }

    return await ctx.runMutation(internal.hub.applyLogChapterPledges, {
      collectionId: args.collectionId,
      viewer_designation: logger.designation,
      logger: {
        its: loggerIts,
        name: logger.name,
        email: logger.email,
        designation: logger.designation,
        jamaat: logger.jamaat,
        coordinator: logger.coordinator,
      },
      pledged_amount: args.pledged_amount,
      entries: resolved,
      note: args.note,
    });
  },
});

type PocScope =
  | { is_poc: false }
  | {
      is_poc: true;
      coordinator_name: string;
      by_jamaat: Record<
        string,
        { its_number: string; name: string; designation?: string }[]
      >;
    };

/**
 * POC (Coordinator) view: niyyat totals for members under their Coordinator name, by jamaat.
 * Bridges member roster → sums admin `hub_contributions`.
 */
export const pocNiyyatTotals = action({
  args: { its_number: v.string() },
  handler: async (ctx, args) => {
    const its = normalizeIts(args.its_number);
    if (!its) return null;

    const memberUrl = process.env.MEMBER_ROSTER_CONVEX_URL?.trim().replace(/\/$/, "");
    const bridgeSecret = process.env.MEMBER_ROSTER_BRIDGE_SECRET;
    if (!memberUrl || !bridgeSecret) {
      throw new Error(
        "Server configuration incomplete: set MEMBER_ROSTER_CONVEX_URL and MEMBER_ROSTER_BRIDGE_SECRET.",
      );
    }

    const client = new ConvexHttpClient(memberUrl);
    let scope: PocScope;
    try {
      scope = (await client.query(pocScopeForItsBridge, {
        its_number: its,
        bridgeSecret,
      })) as PocScope;
    } catch (e) {
      console.error("hub.pocNiyyatTotals: roster bridge failed", e);
      throw new Error("Could not load POC roster. Try again later.");
    }

    if (!scope || !scope.is_poc) {
      return null;
    }

    const itsToMeta = new Map<
      string,
      { name: string; jamaat: string; designation?: string }
    >();
    for (const [jamaat, members] of Object.entries(scope.by_jamaat)) {
      for (const m of members) {
        itsToMeta.set(m.its_number, {
          name: m.name,
          jamaat,
          designation: m.designation,
        });
      }
    }

    const allContributions = await ctx.runQuery(
      internal.hub.listAllContributionsInternal,
      {},
    );

    const jamaatTotals: Record<
      string,
      {
        jamaat: string;
        member_count: number;
        contributors: number;
        total_niyyat: number;
        lines: {
          name: string;
          its_number: string;
          amount: number;
          collection_title: string;
          logged_at: number;
          payment_verified?: boolean;
        }[];
      }
    > = {};

    for (const jamaat of Object.keys(scope.by_jamaat)) {
      jamaatTotals[jamaat] = {
        jamaat,
        member_count: scope.by_jamaat[jamaat].length,
        contributors: 0,
        total_niyyat: 0,
        lines: [],
      };
    }

    const contributorItsByJamaat = new Map<string, Set<string>>();

    for (const row of allContributions) {
      const meta = itsToMeta.get(row.its_number);
      if (!meta) continue;
      const bucket = jamaatTotals[meta.jamaat];
      if (!bucket) continue;
      bucket.total_niyyat += row.amount;
      bucket.lines.push({
        name: meta.name,
        its_number: row.its_number,
        amount: row.amount,
        collection_title: row.collection_title,
        logged_at: row.logged_at,
        payment_verified: row.payment_verified,
      });
      if (!contributorItsByJamaat.has(meta.jamaat)) {
        contributorItsByJamaat.set(meta.jamaat, new Set());
      }
      contributorItsByJamaat.get(meta.jamaat)!.add(row.its_number);
    }

    for (const [jamaat, set] of contributorItsByJamaat) {
      if (jamaatTotals[jamaat]) {
        jamaatTotals[jamaat].contributors = set.size;
        jamaatTotals[jamaat].lines.sort((a, b) => b.logged_at - a.logged_at);
      }
    }

    const jamaats = Object.values(jamaatTotals).sort((a, b) =>
      a.jamaat.localeCompare(b.jamaat),
    );
    const grand_total = jamaats.reduce((s, j) => s + j.total_niyyat, 0);

    return {
      coordinator_name: scope.coordinator_name,
      grand_total,
      jamaats,
    };
  },
});

export const listAllContributionsInternal = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("hub_contributions").collect();
    const out: {
      its_number: string;
      amount: number;
      logged_at: number;
      collection_title: string;
      payment_verified?: boolean;
    }[] = [];

    for (const c of rows) {
      const collection = await ctx.db.get(c.collection_id);
      const collectionTitle = collection?.title ?? "Collection";

      // Chapter batches: attribute each breakdown line to that member (not the secretary total).
      if (c.breakdown && c.breakdown.length > 0) {
        for (const line of c.breakdown) {
          out.push({
            its_number: line.its_number,
            amount: line.amount,
            logged_at: c.logged_at,
            collection_title: collectionTitle,
            payment_verified: effectivePaymentStatus(c) === "verified",
          });
        }
        continue;
      }

      const member = await ctx.db.get(c.member_id);
      if (!member?.its_number) continue;
      out.push({
        its_number: member.its_number,
        amount: c.amount,
        logged_at: c.logged_at,
        collection_title: collectionTitle,
        payment_verified: effectivePaymentStatus(c) === "verified",
      });
    }
    return out;
  },
});
