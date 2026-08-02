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

/** Same normalization as `members.login` / roster import (digits only). */
function normalizeIts(raw: string): string {
  return String(raw ?? "").replace(/\D/g, "");
}

/** Avoid importing `./_generated/api` for the member query (circular with action). */
const lookupByItsForHubBridge = makeFunctionReference(
  "members:lookupByItsForHubBridge",
) as FunctionReference<"query">;

const pocScopeForItsBridge = makeFunctionReference(
  "members:pocScopeForItsBridge",
) as FunctionReference<"query">;

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
      out.push({
        ...c,
        member_name: member?.name ?? "Unknown",
        member_its: member?.its_number ?? "",
        member_email: member?.email,
        member_designation: member?.designation,
        member_jamaat: c.jamaat ?? member?.jamaat,
        collection_title: collection?.title ?? "Unknown collection",
        collection_slug: collection?.slug ?? "",
        desired_memo: collection?.desired_memo ?? "",
      });
    }
    return out;
  },
});

export const setContributionPaymentVerified = mutation({
  args: {
    contributionId: v.id("hub_contributions"),
    verified: v.boolean(),
  },
  handler: async (ctx, { contributionId, verified }) => {
    await requireIdentity(ctx);
    const doc = await ctx.db.get(contributionId);
    if (!doc) throw new Error("Not found");
    await ctx.db.patch(contributionId, {
      payment_verified: verified,
      payment_verified_at: verified ? Date.now() : undefined,
    });
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

      const totalRaised = contributions.reduce((sum, c) => sum + c.amount, 0);
      const contributorIds = new Set(contributions.map((c) => c.member_id));

      results.push({
        ...collection,
        totalRaised,
        contributorCount: contributorIds.size,
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

    const totalRaised = contributions.reduce((sum, c) => sum + c.amount, 0);

    const contributorIds = [...new Set(contributions.map((c) => c.member_id))];
    const contributorNames = [];
    for (const id of contributorIds) {
      const member = await ctx.db.get(id);
      if (member) {
        contributorNames.push(member.name);
      }
    }

    return {
      ...collection,
      totalRaised,
      contributorCount: contributorIds.length,
      contributorNames,
    };
  },
});

/**
 * Internal: upsert admin `members` by ITS (from member-deployment bridge) and insert contribution.
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
  },
  handler: async (ctx, args) => {
    const collection = await ctx.db.get(args.collectionId);
    if (!collection || !collection.is_live || collection.archived) {
      throw new Error("This collection is no longer active.");
    }
    if (!canViewHubCollection(collection.member_portal_audience, args.designation)) {
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

    const contributionId = await ctx.db.insert("hub_contributions", {
      collection_id: args.collectionId,
      member_id: member._id,
      amount: args.amount,
      note: args.note,
      logged_at: now,
      jamaat: args.jamaat ?? member.jamaat,
    });

    return contributionId;
  },
});

/**
 * Log a hub contribution from the member portal (no Clerk on admin client).
 *
 * Verifies ITS on the **member** Convex deployment, then inserts into
 * `hub_contributions` on this (admin) deployment for admins to review in the UI.
 * No automated emails are sent.
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

    const memberUrl = process.env.MEMBER_ROSTER_CONVEX_URL?.trim().replace(/\/$/, "");
    const bridgeSecret = process.env.MEMBER_ROSTER_BRIDGE_SECRET;
    if (!memberUrl || !bridgeSecret) {
      throw new Error(
        "Server configuration incomplete: set MEMBER_ROSTER_CONVEX_URL and MEMBER_ROSTER_BRIDGE_SECRET on this (admin) deployment — same pattern as the survey roster bridge.",
      );
    }

    const client = new ConvexHttpClient(memberUrl);
    let profile: {
      name: string;
      email?: string;
      designation?: string;
      jamaat?: string;
      coordinator?: string;
      can_access_hub?: boolean;
    } | null;
    try {
      profile = (await client.query(lookupByItsForHubBridge, {
        its_number: its,
        bridgeSecret,
      })) as {
        name: string;
        email?: string;
        designation?: string;
        jamaat?: string;
        coordinator?: string;
        can_access_hub?: boolean;
      } | null;
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
      const member = await ctx.db.get(c.member_id);
      if (!member?.its_number) continue;
      const collection = await ctx.db.get(c.collection_id);
      out.push({
        its_number: member.its_number,
        amount: c.amount,
        logged_at: c.logged_at,
        collection_title: collection?.title ?? "Collection",
        payment_verified: c.payment_verified,
      });
    }
    return out;
  },
});
