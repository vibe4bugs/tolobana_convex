import { mutationGeneric as mutation, queryGeneric as query } from "convex/server";
import { v } from "convex/values";

/**
 * Lookup a member by their ITS number.
 * Returns the member object if found, null otherwise.
 */
export const login = mutation({
  args: { its_number: v.string() },
  handler: async (ctx, args) => {
    const member = await ctx.db
      .query("members")
      .withIndex("by_its_number", (q) => q.eq("its_number", args.its_number))
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

export const getById = query({
  args: { memberId: v.id("members") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.memberId);
  },
});
