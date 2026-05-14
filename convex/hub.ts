import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  action,
  internalMutation,
  mutation,
  query,
} from "./_generated/server";

/** Same normalization as `members.login` / roster import (digits only). */
function normalizeIts(raw: string): string {
  return String(raw ?? "").replace(/\D/g, "");
}

/** Avoid importing `./_generated/api` for the member query (circular with action). */
const lookupByItsForHubBridge = makeFunctionReference(
  "members:lookupByItsForHubBridge",
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
    return await ctx.db.query("hub_contributions").collect();
  },
});

/** Live hub collections with totals for the member portal home list. */
export const listLive = query({
  args: {},
  handler: async (ctx) => {
    const collections = await ctx.db
      .query("hub_collections")
      .filter((q) =>
        q.and(q.eq(q.field("is_live"), true), q.neq(q.field("archived"), true)),
      )
      .collect();

    const results = [];
    for (const collection of collections) {
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
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    const collection = await ctx.db
      .query("hub_collections")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .unique();

    if (!collection || !collection.is_live || collection.archived) {
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
    amount: v.number(),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const collection = await ctx.db.get(args.collectionId);
    if (!collection || !collection.is_live || collection.archived) {
      throw new Error("This collection is no longer active.");
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
      });
      member = (await ctx.db.get(member._id))!;
    }

    return await ctx.db.insert("hub_contributions", {
      collection_id: args.collectionId,
      member_id: member._id,
      amount: args.amount,
      note: args.note,
      logged_at: now,
    });
  },
});

/**
 * Log a hub contribution from the member portal (no Clerk on admin client).
 *
 * Verifies ITS on the **member** Convex deployment (`MEMBER_ROSTER_CONVEX_URL`)
 * using `MEMBER_ROSTER_BRIDGE_SECRET` (same as survey roster bridge), then
 * upserts `members` on **this** (admin) deployment and inserts `hub_contributions`.
 *
 * Configure on **admin**: `MEMBER_ROSTER_CONVEX_URL`, `MEMBER_ROSTER_BRIDGE_SECRET`.
 * Configure on **member**: `MEMBER_ROSTER_BRIDGE_SECRET` (same value).
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
    let profile: { name: string; email?: string } | null;
    try {
      profile = (await client.query(lookupByItsForHubBridge, {
        its_number: its,
        bridgeSecret,
      })) as { name: string; email?: string } | null;
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
      amount: args.amount,
      note: args.note,
    });
  },
});
