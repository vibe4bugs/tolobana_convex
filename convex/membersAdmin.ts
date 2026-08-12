import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { makeFunctionReference } from "convex/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalMutation } from "./_generated/server";

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
  if (err instanceof Error && err.message.trim()) return err.message;
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
      created_at: Date.now(),
    });
  },
});

/** List the login roster from the member Convex deployment. */
export const listMembers = action({
  args: {},
  handler: async (ctx): Promise<AdminMemberRow[]> => {
    await requireAdminIdentity(ctx);
    const { client, bridgeSecret } = requireMemberRosterClient();
    try {
      return (await client.query(listAllForBridge, {
        bridgeSecret,
      })) as AdminMemberRow[];
    } catch (err) {
      throw new ConvexError(bridgeErrorMessage(err));
    }
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
      throw new ConvexError(bridgeErrorMessage(err));
    }

    await ctx.runMutation(internal.membersAdmin.upsertLocalMember, {
      its_number: row.its_number,
      name: row.name,
      email: row.email,
      designation: row.designation,
      jamaat: row.jamaat,
      coordinator: row.coordinator,
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
      throw new ConvexError(bridgeErrorMessage(err));
    }

    await ctx.runMutation(internal.membersAdmin.upsertLocalMember, {
      its_number: row.its_number,
      name: row.name,
      email: row.email,
      designation: row.designation,
      jamaat: row.jamaat,
      coordinator: row.coordinator,
    });

    return row;
  },
});
