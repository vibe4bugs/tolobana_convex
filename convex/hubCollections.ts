import { mutationGeneric as mutation, queryGeneric as query } from "convex/server";
import { v } from "convex/values";
import { requireIdentity } from "./auth";

const slugRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function normalizeSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function looksLikeHttpUrl(s: string): boolean {
  const t = s.trim().toLowerCase();
  return t.startsWith("http://") || t.startsWith("https://");
}

export const listHubCollections = query({
  handler: async (ctx) => {
    await requireIdentity(ctx);
    const rows = await ctx.db.query("hub_collections").collect();
    const active = rows.filter((r) => !r.archived);
    active.sort((a, b) => b.updated_at - a.updated_at);
    return active;
  },
});

export const getHubCollection = query({
  args: { hubId: v.id("hub_collections") },
  handler: async (ctx, { hubId }) => {
    await requireIdentity(ctx);
    const doc = await ctx.db.get(hubId);
    if (!doc || doc.archived) return null;
    return doc;
  },
});

export const createHubCollection = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await requireIdentity(ctx);
    const now = Date.now();
    let slug = normalizeSlug(`collect-${now}`);
    if (!slugRegex.test(slug)) slug = `collect-${now}`;
    let candidate = slug;
    let n = 0;
    while (
      await ctx.db
        .query("hub_collections")
        .withIndex("by_slug", (q) => q.eq("slug", candidate))
        .first()
    ) {
      n += 1;
      candidate = `${slug}-${n}`;
    }
    return await ctx.db.insert("hub_collections", {
      title: "Untitled collection",
      slug: candidate,
      amount_display: "",
      payment_url: "",
      desired_memo: "",
      is_live: false,
      created_at: now,
      updated_at: now,
      created_by: identity.subject,
    });
  },
});

export const updateHubCollection = mutation({
  args: {
    hubId: v.id("hub_collections"),
    title: v.string(),
    slug: v.string(),
    amount_display: v.string(),
    payment_url: v.string(),
    desired_memo: v.string(),
  },
  handler: async (ctx, args) => {
    await requireIdentity(ctx);
    const doc = await ctx.db.get(args.hubId);
    if (!doc || doc.archived) throw new Error("Not found");
    const normalized = normalizeSlug(args.slug);
    if (!normalized || !slugRegex.test(normalized)) {
      throw new Error("Slug must be lowercase letters, numbers, and hyphens only.");
    }
    if (normalized !== doc.slug) {
      const existing = await ctx.db
        .query("hub_collections")
        .withIndex("by_slug", (q) => q.eq("slug", normalized))
        .first();
      if (existing && existing._id !== args.hubId) {
        throw new Error("That slug is already in use.");
      }
    }
    await ctx.db.patch(args.hubId, {
      title: args.title.trim() || "Untitled collection",
      slug: normalized,
      amount_display: args.amount_display.trim(),
      payment_url: args.payment_url.trim(),
      desired_memo: args.desired_memo.trim(),
      updated_at: Date.now(),
    });
  },
});

export const setHubCollectionLive = mutation({
  args: {
    hubId: v.id("hub_collections"),
    is_live: v.boolean(),
  },
  handler: async (ctx, { hubId, is_live }) => {
    await requireIdentity(ctx);
    const doc = await ctx.db.get(hubId);
    if (!doc || doc.archived) throw new Error("Not found");

    if (is_live) {
      if (!doc.amount_display.trim()) {
        throw new Error("Add the amount or amount label before publishing.");
      }
      if (!doc.payment_url.trim() || !looksLikeHttpUrl(doc.payment_url)) {
        throw new Error("Add a valid payment link (https://…) before publishing.");
      }
      if (!doc.desired_memo.trim()) {
        throw new Error("Add the desired memo text before publishing.");
      }
    }

    await ctx.db.patch(hubId, {
      is_live,
      updated_at: Date.now(),
    });
  },
});

export const archiveHubCollection = mutation({
  args: { hubId: v.id("hub_collections") },
  handler: async (ctx, { hubId }) => {
    await requireIdentity(ctx);
    const doc = await ctx.db.get(hubId);
    if (!doc) throw new Error("Not found");
    await ctx.db.patch(hubId, {
      archived: true,
      is_live: false,
      updated_at: Date.now(),
    });
  },
});
