"use node";

import { sendNotification, setVapidDetails } from "web-push";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

type Subscription = {
  endpoint: string;
  p256dh: string;
  auth: string;
};

function vapidReady(): boolean {
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  if (!publicKey || !privateKey) {
    console.error("Push is not configured. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY.");
    return false;
  }
  setVapidDetails(
    process.env.VAPID_SUBJECT?.trim() || "mailto:notifications@toloba.org",
    publicKey,
    privateKey,
  );
  return true;
}

async function deliver(
  ctx: { runMutation: (ref: typeof internal.push.removeByEndpoint, args: { endpoint: string }) => Promise<unknown> },
  subs: Subscription[],
  title: string,
  body: string,
  url: string,
) {
  if (!vapidReady() || subs.length === 0) return;

  const payload = JSON.stringify({ title, body, url });
  let cursor = 0;
  const workers = Array.from({ length: Math.min(20, subs.length) }, async () => {
    while (cursor < subs.length) {
      const sub = subs[cursor];
      cursor += 1;
      if (!sub) return;
      try {
        await sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          payload,
          { TTL: 60 * 60 * 12 },
        );
      } catch (err) {
        const status =
          typeof err === "object" && err && "statusCode" in err
            ? Number((err as { statusCode: number }).statusCode)
            : 0;
        if (status === 404 || status === 410) {
          await ctx.runMutation(internal.push.removeByEndpoint, { endpoint: sub.endpoint });
        } else {
          console.error("Push delivery failed", status || "unknown");
        }
      }
    }
  });
  await Promise.all(workers);
}

export const broadcast = internalAction({
  args: {
    title: v.string(),
    body: v.string(),
    url: v.string(),
  },
  handler: async (ctx, args) => {
    const subs = await ctx.runQuery(internal.push.listAll, {});
    await deliver(ctx, subs, args.title, args.body, args.url);
  },
});

export const toMembers = internalAction({
  args: {
    memberIds: v.array(v.id("members")),
    title: v.string(),
    body: v.string(),
    url: v.string(),
  },
  handler: async (ctx, args) => {
    if (args.memberIds.length === 0) return;
    const subs = await ctx.runQuery(internal.push.listForMembers, {
      memberIds: args.memberIds,
    });
    await deliver(ctx, subs, args.title, args.body, args.url);
  },
});
