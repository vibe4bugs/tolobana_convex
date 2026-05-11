import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { makeFunctionReference } from "convex/server";
import { ConvexError, v } from "convex/values";
import { action } from "./_generated/server";
import { normalizeEmail } from "./email";

const MAX_EMAILS = 200;

/** Avoid importing `./_generated/api` here (circular types with this action). */
const batchLookupByEmailsForBridge = makeFunctionReference(
  "members:batchLookupByEmailsForBridge",
) as FunctionReference<"query">;

/**
 * For admin users only: fetch `{ its_number, name }` from the **member** Convex deployment
 * (e.g. mild-hedgehog-2) when surveys live on a different deployment.
 *
 * Configure on the **admin/surveys** deployment only:
 * - `MEMBER_ROSTER_CONVEX_URL` — base URL, e.g. `https://mild-hedgehog-2.convex.cloud`
 * - `MEMBER_ROSTER_BRIDGE_SECRET` — long random string (must match the **member** deployment).
 *
 * On the **member** deployment, set the same `MEMBER_ROSTER_BRIDGE_SECRET` (Dashboard → Environment variables).
 * If either admin env var is missing, this action returns `{}` and the UI falls back to local `members` only.
 */
export const fetchMemberRosterByEmails = action({
  args: { emails: v.array(v.string()) },
  handler: async (ctx, { emails }): Promise<Record<string, { its_number: string; name: string }>> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new ConvexError("Unauthorized");
    }

    const memberUrl = process.env.MEMBER_ROSTER_CONVEX_URL?.trim().replace(/\/$/, "");
    const bridgeSecret = process.env.MEMBER_ROSTER_BRIDGE_SECRET;
    if (!memberUrl || !bridgeSecret) {
      return {};
    }

    const normalized = [
      ...new Set(
        emails
          .map((e) => (e.trim() ? normalizeEmail(e) : ""))
          .filter((e) => e.length > 0),
      ),
    ].slice(0, MAX_EMAILS);

    if (normalized.length === 0) {
      return {};
    }

    const client = new ConvexHttpClient(memberUrl);
    try {
      const data = (await client.query(batchLookupByEmailsForBridge, {
        emails: normalized,
        bridgeSecret,
      })) as Record<string, { its_number: string; name: string }>;
      return data;
    } catch (e) {
      console.error("surveyRosterBridge: member deployment query failed", e);
      return {};
    }
  },
});
