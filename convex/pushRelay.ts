"use node";

import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

const enqueueBroadcast = makeFunctionReference<
  "mutation",
  { bridgeSecret: string; title: string; body: string; url: string },
  null
>("push:enqueueBroadcast");

/**
 * Announcements and surveys are published on the admin deployment.
 * Subscriptions live with the members, so this relays the alert there.
 * When this deployment is already the member deployment, it sends directly.
 */
export const broadcast = internalAction({
  args: {
    title: v.string(),
    body: v.string(),
    url: v.string(),
  },
  handler: async (ctx, args) => {
    const memberUrl = process.env.MEMBER_ROSTER_CONVEX_URL?.trim().replace(/\/$/, "");
    const bridgeSecret = process.env.MEMBER_ROSTER_BRIDGE_SECRET;
    if (!memberUrl || !bridgeSecret) {
      await ctx.runAction(internal.pushSend.broadcast, args);
      return;
    }

    const client = new ConvexHttpClient(memberUrl);
    try {
      await client.mutation(enqueueBroadcast, {
        bridgeSecret,
        title: args.title,
        body: args.body,
        url: args.url,
      });
    } catch (err) {
      console.error("Push relay to the member deployment failed");
      console.error(err instanceof Error ? err.message : "unknown");
    }
  },
});
