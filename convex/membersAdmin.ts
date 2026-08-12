import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { makeFunctionReference } from "convex/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import {
  action,
  internalMutation,
  query,
} from "./_generated/server";
import { requireIdentity } from "./auth";

/** Avoid importing `./_generated/api` public refs here (circular types with bridge refs). */
const listAllForBridge = makeFunctionReference(
  "members:listAllForBridge",
) as FunctionReference<"query">;
const createForBridge = makeFunctionReference(
  "members:createForBridge",
) as FunctionReference<"mutation">;
const updateForBridge = makeFunctionReference(
  "members:updateForBridge",
) as FunctionReference<"mutation">;

export type AdminMemberRow = {
  its_number: string;
  name: string;
  email?: string;
  designation?: string;
  jamaat?: string;
  coordinator?: string;
  created_at: number;
};

const memberRowValidator = v.object({
  its_number: v.string(),
  name: v.string(),
  email: v.optional(v.string()),
  designation: v.optional(v.string()),
  jamaat: v.optional(v.string()),
  coordinator: v.optional(v.string()),
  created_at: v.number(),
});

function requireMemberRosterClient(): {
  client: ConvexHttpClient;
  bridgeSecret: string;
} {
  const memberUrl = process.env.MEMBER_ROSTER_CONVEX_URL?.trim().replace(
    /\/$/,
    "",
  );
  const bridgeSecret = process.env.MEMBER_ROSTER_BRIDGE_SECRET;
  if (!memberUrl || !bridgeSecret) {
    throw new ConvexError(
      "Server configuration incomplete: set MEMBER_ROSTER_CONVEX_URL and MEMBER_ROSTER_BRIDGE_SECRET on this (admin) deployment.",
    );
  }
  return { client: new ConvexHttpClient(memberUrl), bridgeSecret };
}

async function requireAdminIdentity(ctx: {
  auth: { getUserIdentity: () => Promise<unknown> };
}) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new ConvexError("Unauthorized");
  }
  return identity;
}

function bridgeErrorMessage(err: unknown): string {
  if (err && typeof err === "object" && "data" in err) {
    const data = (err as { data?: unknown }).data;
    if (typeof data === "string" && data.trim()) return data;
    if (data && typeof data === "object" && "message" in data) {
      const message = (data as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) return message;
    }
  }
  if (err instanceof Error && err.message.trim()) {
    const uncaught = err.message.match(/Uncaught ConvexError:\s*(.+)/);
    if (uncaught?.[1]) return uncaught[1].split("\n")[0]!.trim();
    return err.message;
  }
  return "Member roster request failed.";
}

/**
 * Upsert admin-local `members` mirror (used by hub contributions). Login still
 * uses the member deployment; this keeps ITS metadata available on admin.
 */
export const upsertLocalMember = internalMutation({
  args: {
    its_number: v.string(),
    name: v.string(),
    email: v.optional(v.string()),
    designation: v.optional(v.string()),
    jamaat: v.optional(v.string()),
    coordinator: v.optional(v.string()),
    created_at: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const member = await ctx.db
      .query("members")
      .withIndex("by_its_number", (q) => q.eq("its_number", args.its_number))
      .unique();

    if (member) {
      await ctx.db.patch(member._id, {
        name: args.name,
        email: args.email,
        designation: args.designation,
        jamaat: args.jamaat,
        coordinator: args.coordinator,
      });
      return member._id;
    }

    return await ctx.db.insert("members", {
      its_number: args.its_number,
      name: args.name,
      email: args.email,
      designation: args.designation,
      jamaat: args.jamaat,
      coordinator: args.coordinator,
      created_at: args.created_at ?? Date.now(),
    });
  },
});

/** Bulk upsert local mirror after a roster sync from the member deployment. */
export const upsertLocalMembersBulk = internalMutation({
  args: { rows: v.array(memberRowValidator) },
  handler: async (ctx, { rows }) => {
    let upserted = 0;
    for (const row of rows) {
      const existing = await ctx.db
        .query("members")
        .withIndex("by_its_number", (q) => q.eq("its_number", row.its_number))
        .unique();
      if (existing) {
        await ctx.db.patch(existing._id, {
          name: row.name,
          email: row.email,
          designation: row.designation,
          jamaat: row.jamaat,
          coordinator: row.coordinator,
        });
      } else {
        await ctx.db.insert("members", {
          its_number: row.its_number,
          name: row.name,
          email: row.email,
          designation: row.designation,
          jamaat: row.jamaat,
          coordinator: row.coordinator,
          created_at: row.created_at,
        });
      }
      upserted += 1;
    }
    return { upserted };
  },
});

/**
 * List roster rows from the admin-local mirror (filled by `syncMembers` /
 * create / update). Prefer this over a large cross-deployment action return.
 */
export const listMembers = query({
  args: {},
  handler: async (ctx) => {
    await requireIdentity(ctx);
    const rows = await ctx.db.query("members").collect();
    rows.sort((a, b) => a.name.localeCompare(b.name));
    return rows.map((m) => ({
      its_number: m.its_number,
      name: m.name,
      email: m.email,
      designation: m.designation,
      jamaat: m.jamaat,
      coordinator: m.coordinator,
      created_at: m.created_at,
    }));
  },
});

/** Pull the login roster from the member deployment into the admin mirror. */
export const syncMembers = action({
  args: {},
  handler: async (ctx): Promise<{ upserted: number }> => {
    await requireAdminIdentity(ctx);
    const { client, bridgeSecret } = requireMemberRosterClient();

    let rows: AdminMemberRow[];
    try {
      rows = (await client.query(listAllForBridge, {
        bridgeSecret,
      })) as AdminMemberRow[];
    } catch (err) {
      console.error("membersAdmin.syncMembers: bridge list failed", err);
      throw new ConvexError(bridgeErrorMessage(err));
    }

    // Chunk to stay within mutation limits on large rosters.
    const CHUNK = 100;
    let upserted = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK);
      const result = await ctx.runMutation(
        internal.membersAdmin.upsertLocalMembersBulk,
        { rows: slice },
      );
      upserted += result.upserted;
    }
    return { upserted };
  },
});

/** Create a member on the login roster; mirror onto admin `members`. */
export const createMember = action({
  args: {
    its_number: v.string(),
    name: v.string(),
    email: v.optional(v.string()),
    designation: v.optional(v.string()),
    jamaat: v.optional(v.string()),
    coordinator: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<AdminMemberRow> => {
    await requireAdminIdentity(ctx);
    const { client, bridgeSecret } = requireMemberRosterClient();

    let row: AdminMemberRow;
    try {
      row = (await client.mutation(createForBridge, {
        bridgeSecret,
        its_number: args.its_number,
        name: args.name,
        email: args.email,
        designation: args.designation,
        jamaat: args.jamaat,
        coordinator: args.coordinator,
      })) as AdminMemberRow;
    } catch (err) {
      console.error("membersAdmin.createMember: bridge create failed", err);
      throw new ConvexError(bridgeErrorMessage(err));
    }

    await ctx.runMutation(internal.membersAdmin.upsertLocalMember, {
      its_number: row.its_number,
      name: row.name,
      email: row.email,
      designation: row.designation,
      jamaat: row.jamaat,
      coordinator: row.coordinator,
      created_at: row.created_at,
    });

    return row;
  },
});

/** Update a member on the login roster; ITS is immutable. Mirror onto admin `members`. */
export const updateMember = action({
  args: {
    its_number: v.string(),
    name: v.string(),
    email: v.optional(v.string()),
    designation: v.optional(v.string()),
    jamaat: v.optional(v.string()),
    coordinator: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<AdminMemberRow> => {
    await requireAdminIdentity(ctx);
    const { client, bridgeSecret } = requireMemberRosterClient();

    let row: AdminMemberRow;
    try {
      row = (await client.mutation(updateForBridge, {
        bridgeSecret,
        its_number: args.its_number,
        name: args.name,
        email: args.email,
        designation: args.designation,
        jamaat: args.jamaat,
        coordinator: args.coordinator,
      })) as AdminMemberRow;
    } catch (err) {
      console.error("membersAdmin.updateMember: bridge update failed", err);
      throw new ConvexError(bridgeErrorMessage(err));
    }

    await ctx.runMutation(internal.membersAdmin.upsertLocalMember, {
      its_number: row.its_number,
      name: row.name,
      email: row.email,
      designation: row.designation,
      jamaat: row.jamaat,
      coordinator: row.coordinator,
      created_at: row.created_at,
    });

    return row;
  },
});
