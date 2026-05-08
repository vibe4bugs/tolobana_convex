import { queryGeneric as query } from "convex/server";
import { v } from "convex/values";

/**
 * Public landing page for a payment collection — only when `is_live` is true.
 */
export const getLiveHubBySlug = query({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const normalized = slug.trim().toLowerCase();
    const doc = await ctx.db
      .query("hub_collections")
      .withIndex("by_slug", (q) => q.eq("slug", normalized))
      .first();
    if (!doc || doc.archived || !doc.is_live) return null;
    return {
      title: doc.title,
      amount_display: doc.amount_display,
      payment_url: doc.payment_url,
      desired_memo: doc.desired_memo,
      updated_at: doc.updated_at,
    };
  },
});
