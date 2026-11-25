import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";

type DbCtx = QueryCtx | MutationCtx;

export function clip(raw: string, max = 160): string {
  const text = raw.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function cleanPath(url: string): string {
  const path = url.trim();
  if (!path.startsWith("/") || path.startsWith("//") || path.length > 200) {
    throw new ConvexError("Notification link is invalid.");
  }
  return path;
}

async function signedInMemberId(ctx: DbCtx): Promise<Id<"members"> | null> {
  const userId = await getAuthUserId(ctx);
  if (!userId) return null;

  const accounts = await ctx.db
    .query("authAccounts")
    .withIndex("userIdAndProvider", (q) => q.eq("userId", userId))
    .collect();
  const account = accounts.find((row) => row.provider === "its");
  if (!account) return null;

  const member = await ctx.db
    .query("members")
    .withIndex("by_its_number", (q) => q.eq("its_number", account.providerAccountId))
    .unique();
  return member?._id ?? null;
}

function assertBridgeSecret(bridgeSecret: string) {
  const expected = process.env.MEMBER_ROSTER_BRIDGE_SECRET;
  if (!expected || bridgeSecret !== expected) {
    throw new ConvexError("Unauthorized");
  }
}

/** Public key the browser uses to subscribe. The private key stays on the server. */
export const publicKey = query({
  args: {},
  handler: async (ctx) => {
    const memberId = await signedInMemberId(ctx);
    if (!memberId) return null;
    return process.env.VAPID_PUBLIC_KEY?.trim() || null;
  },
});

export const saveSubscription = mutation({
  args: {
    endpoint: v.string(),
    p256dh: v.string(),
    auth: v.string(),
  },
  handler: async (ctx, args) => {
    const memberId = await signedInMemberId(ctx);
    if (!memberId) throw new ConvexError("Sign in to continue.");

    const endpoint = args.endpoint.trim();
    const p256dh = args.p256dh.trim();
    const auth = args.auth.trim();
    if (!endpoint || endpoint.length > 2000 || !p256dh || p256dh.length > 200 || !auth || auth.length > 200) {
      throw new ConvexError("That notification subscription is invalid.");
    }

    const now = Date.now();
    const existing = await ctx.db
      .query("push_subscriptions")
      .withIndex("by_endpoint", (q) => q.eq("endpoint", endpoint))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        member_id: memberId,
        p256dh,
        auth,
        updated_at: now,
      });
      return null;
    }

    await ctx.db.insert("push_subscriptions", {
      member_id: memberId,
      endpoint,
      p256dh,
      auth,
      created_at: now,
      updated_at: now,
    });
    return null;
  },
});

export const removeSubscription = mutation({
  args: { endpoint: v.string() },
  handler: async (ctx, args) => {
    const memberId = await signedInMemberId(ctx);
    if (!memberId) throw new ConvexError("Sign in to continue.");

    const existing = await ctx.db
      .query("push_subscriptions")
      .withIndex("by_endpoint", (q) => q.eq("endpoint", args.endpoint.trim()))
      .unique();
    if (existing && existing.member_id === memberId) {
      await ctx.db.delete(existing._id);
    }
    return null;
  },
});

/** Admin deployments ask the member deployment to notify everyone. */
export const enqueueBroadcast = mutation({
  args: {
    bridgeSecret: v.string(),
    title: v.string(),
    body: v.string(),
    url: v.string(),
  },
  handler: async (ctx, args) => {
    assertBridgeSecret(args.bridgeSecret);
    await ctx.scheduler.runAfter(0, internal.pushSend.broadcast, {
      title: clip(args.title, 80) || "Toloba NA",
      body: clip(args.body),
      url: cleanPath(args.url),
    });
    return null;
  },
});

export const listAll = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("push_subscriptions").collect();
    return rows.map((row) => ({
      endpoint: row.endpoint,
      p256dh: row.p256dh,
      auth: row.auth,
    }));
  },
});

export const listForMembers = internalQuery({
  args: { memberIds: v.array(v.id("members")) },
  handler: async (ctx, { memberIds }) => {
    const rows = [];
    for (const memberId of memberIds) {
      const found = await ctx.db
        .query("push_subscriptions")
        .withIndex("by_member", (q) => q.eq("member_id", memberId))
        .collect();
      rows.push(...found);
    }
    return rows.map((row) => ({
      endpoint: row.endpoint,
      p256dh: row.p256dh,
      auth: row.auth,
    }));
  },
});

export const removeByEndpoint = internalMutation({
  args: { endpoint: v.string() },
  handler: async (ctx, { endpoint }) => {
    const existing = await ctx.db
      .query("push_subscriptions")
      .withIndex("by_endpoint", (q) => q.eq("endpoint", endpoint))
      .unique();
    if (existing) await ctx.db.delete(existing._id);
  },
});
