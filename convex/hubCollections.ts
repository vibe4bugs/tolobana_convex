import { mutationGeneric as mutation, queryGeneric as query } from "convex/server";
import { v } from "convex/values";
import { requireIdentity } from "./auth";

const slugRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const memberPortalAudienceValidator = v.union(
  v.literal("all_members"),
  v.literal("leadership"),
);

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
      member_portal_audience: "leadership",
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
    zelle_contact: v.optional(v.string()),
    desired_memo: v.string(),
    verification_sla_business_days: v.optional(v.number()),
    member_portal_audience: memberPortalAudienceValidator,
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
    const sla = args.verification_sla_business_days;
    if (sla !== undefined && (!Number.isFinite(sla) || sla < 1 || sla > 30)) {
      throw new Error("Verification SLA must be between 1 and 30 business days.");
    }
    await ctx.db.patch(args.hubId, {
      title: args.title.trim() || "Untitled collection",
      slug: normalized,
      amount_display: args.amount_display.trim(),
      payment_url: args.payment_url.trim(),
      zelle_contact: args.zelle_contact?.trim() || undefined,
      desired_memo: args.desired_memo.trim(),
      ...(sla !== undefined ? { verification_sla_business_days: Math.round(sla) } : {}),
      member_portal_audience: args.member_portal_audience,
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
      const hasZelle = !!(doc.zelle_contact && doc.zelle_contact.trim());
      const hasUrl =
        !!(doc.payment_url && doc.payment_url.trim()) &&
        looksLikeHttpUrl(doc.payment_url);
      if (!hasZelle && !hasUrl) {
        throw new Error(
          "Add a Zelle email/phone (or a valid payment link) before publishing.",
        );
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
