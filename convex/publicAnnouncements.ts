import { queryGeneric as query } from "convex/server";

/**
 * Public feed for the marketing site — only announcements marked live are returned.
 */
export const listLiveAnnouncements = query({
  handler: async (ctx) => {
    const live = await ctx.db
      .query("announcements")
      .withIndex("by_live", (q) => q.eq("is_live", true))
      .collect();
    const rows = live.filter((a) => !a.archived);
    rows.sort((a, b) => b.updated_at - a.updated_at);
    return rows.map((a) => ({
      _id: a._id,
      title: a.title,
      body: a.body,
      updated_at: a.updated_at,
    }));
  },
});
