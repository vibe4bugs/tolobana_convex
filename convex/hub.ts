import { mutationGeneric as mutation, queryGeneric as query } from "convex/server";
import { v } from "convex/values";

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

export const logContribution = mutation({
  args: {
    collectionId: v.id("hub_collections"),
    memberId: v.id("members"),
    amount: v.number(),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const collection = await ctx.db.get(args.collectionId);
    if (!collection || !collection.is_live || collection.archived) {
      throw new Error("This collection is no longer active.");
    }

    const member = await ctx.db.get(args.memberId);
    if (!member) {
      throw new Error("Invalid member session.");
    }

    if (args.amount <= 0) {
      throw new Error("Amount must be greater than zero.");
    }

    return await ctx.db.insert("hub_contributions", {
      collection_id: args.collectionId,
      member_id: args.memberId,
      amount: args.amount,
      note: args.note,
      logged_at: Date.now(),
    });
  },
});
