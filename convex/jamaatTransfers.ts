import { getAuthUserId } from "@convex-dev/auth/server";
import {
  mutationGeneric as mutation,
  queryGeneric as query,
  type GenericMutationCtx,
  type GenericQueryCtx,
} from "convex/server";
import { ConvexError, v } from "convex/values";
import type { DataModel } from "./_generated/dataModel";
import { canLogChapterPledges } from "./hubAccess";

type DbCtx = GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>;

function jamaatKey(raw: string | undefined | null): string {
  return String(raw ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ");
}

const POSITION_ORDER = [
  "patron",
  "management member",
  "coordinator",
  "secretary",
  "joint secretary",
  "treasurer",
  "joint treasurer",
  "member",
];

function positionRank(designation: string | undefined): number {
  const key = String(designation ?? "member").trim().toLowerCase() || "member";
  const index = POSITION_ORDER.indexOf(key);
  return index === -1 ? POSITION_ORDER.length : index;
}

function positionLabel(designation: string | undefined): string {
  const label = String(designation ?? "").trim();
  return label || "Member";
}

async function signedInMember(ctx: DbCtx) {
  const userId = await getAuthUserId(ctx);
  if (!userId) return null;

  const accounts = await ctx.db
    .query("authAccounts")
    .withIndex("userIdAndProvider", (q) => q.eq("userId", userId))
    .collect();
  const account = accounts.find((row) => row.provider === "its");
  if (!account) return null;

  return await ctx.db
    .query("members")
    .withIndex("by_its_number", (q) => q.eq("its_number", account.providerAccountId))
    .unique();
}

async function requireMember(ctx: DbCtx) {
  const member = await signedInMember(ctx);
  if (!member) throw new ConvexError("Sign in to continue.");
  return member;
}

function assertSecretary(member: { designation?: string; jamaat?: string }) {
  if (!canLogChapterPledges(member.designation)) {
    throw new ConvexError("Only a secretary or joint secretary can transfer members.");
  }
  if (!jamaatKey(member.jamaat)) {
    throw new ConvexError("Your membership has no jamaat.");
  }
}

/** Members of the signed-in person's jamaat, plus transfer tools for secretaries. */
export const myJamaat = query({
  args: {},
  handler: async (ctx) => {
    const caller = await signedInMember(ctx);
    if (!caller) return null;

    const home = jamaatKey(caller.jamaat);
    const members = await ctx.db.query("members").collect();
    const pending = await ctx.db
      .query("jamaat_transfers")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .collect();

    const roster = members
      .filter((member) => jamaatKey(member.jamaat) === home && home)
      .map((member) => {
        const request = pending.find((row) => row.member_id === member._id);
        return {
          id: member._id,
          name: member.name,
          designation: positionLabel(member.designation),
          pendingTo: request?.to_jamaat ?? null,
          pendingId: request?._id ?? null,
        };
      })
      .sort(
        (a, b) =>
          positionRank(a.designation) - positionRank(b.designation) ||
          a.name.localeCompare(b.name),
      );

    const canTransfer = canLogChapterPledges(caller.designation) && Boolean(home);
    const cities = canTransfer
      ? [...new Set(members.map((member) => String(member.jamaat ?? "").trim()).filter(Boolean))]
          .filter((jamaat) => jamaatKey(jamaat) !== home)
          .sort((a, b) => a.localeCompare(b))
          .map((jamaat) => ({ jamaat }))
      : [];

    const incoming = canTransfer
      ? pending
          .filter((row) => jamaatKey(row.to_jamaat) === home)
          .map((row) => {
            const member = members.find((item) => item._id === row.member_id);
            return {
              id: row._id,
              name: member?.name ?? "Member",
              designation: positionLabel(member?.designation),
              fromJamaat: row.from_jamaat,
            };
          })
          .sort((a, b) => a.name.localeCompare(b.name))
      : [];

    return {
      jamaat: caller.jamaat?.trim() || null,
      canTransfer,
      members: roster,
      incoming,
      cities,
    };
  },
});

export const requestTransfer = mutation({
  args: {
    memberId: v.id("members"),
    toJamaat: v.string(),
  },
  handler: async (ctx, args) => {
    const caller = await requireMember(ctx);
    assertSecretary(caller);

    const member = await ctx.db.get(args.memberId);
    if (!member) throw new ConvexError("That member is not on the roster.");
    if (jamaatKey(member.jamaat) !== jamaatKey(caller.jamaat)) {
      throw new ConvexError("You can only transfer members from your jamaat.");
    }

    const destinationKey = jamaatKey(args.toJamaat);
    if (!destinationKey || destinationKey === jamaatKey(caller.jamaat)) {
      throw new ConvexError("Choose a different jamaat.");
    }

    const members = await ctx.db.query("members").collect();
    const destination = members.find((row) => jamaatKey(row.jamaat) === destinationKey);
    if (!destination?.jamaat) throw new ConvexError("That jamaat is not on the roster.");

    const pending = await ctx.db
      .query("jamaat_transfers")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .collect();
    if (pending.some((row) => row.member_id === member._id)) {
      throw new ConvexError("That member already has a transfer waiting.");
    }

    await ctx.db.insert("jamaat_transfers", {
      member_id: member._id,
      from_jamaat: String(member.jamaat).trim(),
      to_jamaat: destination.jamaat.trim(),
      requested_by: caller._id,
      status: "pending",
      created_at: Date.now(),
    });
    return null;
  },
});

export const acceptTransfer = mutation({
  args: { transferId: v.id("jamaat_transfers") },
  handler: async (ctx, args) => {
    const caller = await requireMember(ctx);
    assertSecretary(caller);

    const transfer = await ctx.db.get(args.transferId);
    if (!transfer || transfer.status !== "pending") {
      throw new ConvexError("That transfer is no longer waiting.");
    }
    if (jamaatKey(transfer.to_jamaat) !== jamaatKey(caller.jamaat)) {
      throw new ConvexError("A secretary of the receiving jamaat accepts this transfer.");
    }

    const member = await ctx.db.get(transfer.member_id);
    if (!member || jamaatKey(member.jamaat) !== jamaatKey(transfer.from_jamaat)) {
      throw new ConvexError("That member is no longer in the sending jamaat.");
    }

    await ctx.db.patch(member._id, { jamaat: transfer.to_jamaat });
    await ctx.db.patch(transfer._id, {
      status: "accepted",
      resolved_at: Date.now(),
      resolved_by: caller._id,
    });
    return null;
  },
});

export const declineTransfer = mutation({
  args: { transferId: v.id("jamaat_transfers") },
  handler: async (ctx, args) => {
    const caller = await requireMember(ctx);
    assertSecretary(caller);

    const transfer = await ctx.db.get(args.transferId);
    if (!transfer || transfer.status !== "pending") {
      throw new ConvexError("That transfer is no longer waiting.");
    }
    if (jamaatKey(transfer.to_jamaat) !== jamaatKey(caller.jamaat)) {
      throw new ConvexError("A secretary of the receiving jamaat reviews this transfer.");
    }

    await ctx.db.patch(transfer._id, {
      status: "declined",
      resolved_at: Date.now(),
      resolved_by: caller._id,
    });
    return null;
  },
});

export const cancelTransfer = mutation({
  args: { transferId: v.id("jamaat_transfers") },
  handler: async (ctx, args) => {
    const caller = await requireMember(ctx);
    assertSecretary(caller);

    const transfer = await ctx.db.get(args.transferId);
    if (!transfer || transfer.status !== "pending") {
      throw new ConvexError("That transfer is no longer waiting.");
    }
    if (jamaatKey(transfer.from_jamaat) !== jamaatKey(caller.jamaat)) {
      throw new ConvexError("A secretary of the sending jamaat can cancel this transfer.");
    }

    await ctx.db.patch(transfer._id, {
      status: "cancelled",
      resolved_at: Date.now(),
      resolved_by: caller._id,
    });
    return null;
  },
});
