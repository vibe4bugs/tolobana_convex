import { mutationGeneric as mutation, queryGeneric as query } from "convex/server";
import { v } from "convex/values";
import { requireIdentity } from "./auth";

export const listAnnouncements = query({
  handler: async (ctx) => {
    await requireIdentity(ctx);
    const rows = await ctx.db.query("announcements").collect();
    const active = rows.filter((r) => !r.archived);
    active.sort((a, b) => b.updated_at - a.updated_at);
    return active;
  },
});

export const getAnnouncement = query({
  args: { announcementId: v.id("announcements") },
  handler: async (ctx, { announcementId }) => {
    await requireIdentity(ctx);
    const doc = await ctx.db.get(announcementId);
    if (!doc || doc.archived) return null;
    return doc;
  },
});

export const createAnnouncement = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await requireIdentity(ctx);
    const now = Date.now();
    return await ctx.db.insert("announcements", {
      title: "Untitled announcement",
      body: "",
      is_live: false,
      created_at: now,
      updated_at: now,
      created_by: identity.subject,
    });
  },
});

export const updateAnnouncement = mutation({
  args: {
    announcementId: v.id("announcements"),
    title: v.string(),
    body: v.string(),
  },
  handler: async (ctx, { announcementId, title, body }) => {
    await requireIdentity(ctx);
    const doc = await ctx.db.get(announcementId);
    if (!doc || doc.archived) throw new Error("Not found");
    await ctx.db.patch(announcementId, {
      title: title.trim() || "Untitled announcement",
      body,
      updated_at: Date.now(),
    });
  },
});

export const setAnnouncementLive = mutation({
  args: {
    announcementId: v.id("announcements"),
    is_live: v.boolean(),
  },
  handler: async (ctx, { announcementId, is_live }) => {
    await requireIdentity(ctx);
    const doc = await ctx.db.get(announcementId);
    if (!doc || doc.archived) throw new Error("Not found");

    if (is_live && !doc.body.trim()) {
      throw new Error("Add announcement content before publishing.");
    }

    await ctx.db.patch(announcementId, {
      is_live,
      updated_at: Date.now(),
    });
  },
});

export const archiveAnnouncement = mutation({
  args: { announcementId: v.id("announcements") },
  handler: async (ctx, { announcementId }) => {
    await requireIdentity(ctx);
    const doc = await ctx.db.get(announcementId);
    if (!doc) throw new Error("Not found");
    await ctx.db.patch(announcementId, {
      archived: true,
      is_live: false,
      updated_at: Date.now(),
    });
  },
});

// ---------------------------------------------------------------------------
// Member portal (no Clerk): `api.announcements.listLive`
// ---------------------------------------------------------------------------

/** All announcements (member tooling / debugging). */
export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("announcements").collect();
  },
});

/** Live feed for the member portal. */
export const listLive = query({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("announcements").collect();
    return all
      .filter((a) => a.is_live && !a.archived)
      .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
  },
});
