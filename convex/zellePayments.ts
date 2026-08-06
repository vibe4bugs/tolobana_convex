import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { requireIdentity } from "./auth";
import {
  DEFAULT_VERIFICATION_SLA_BUSINESS_DAYS,
  PENDING_PAYMENT_EXPIRY_DAYS,
  VERIFICATION_FOLLOWUP_BUSINESS_DAYS,
  businessDaysBetween,
  effectivePaymentStatus,
  msFromDays,
} from "./zelleConfig";

type DbCtx = QueryCtx | MutationCtx;

function normalizeConfirmation(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

async function findDuplicateConfirmation(
  ctx: DbCtx,
  confirmationNumber: string,
  excludeId?: Id<"hub_contributions">,
): Promise<Id<"hub_contributions"> | null> {
  const normalized = normalizeConfirmation(confirmationNumber).toLowerCase();
  if (!normalized) return null;

  const byPrimary = await ctx.db
    .query("hub_contributions")
    .withIndex("by_confirmation_number", (q) =>
      q.eq("confirmation_number", confirmationNumber.trim()),
    )
    .collect();

  for (const row of byPrimary) {
    if (excludeId && row._id === excludeId) continue;
    return row._id;
  }

  const all = await ctx.db.query("hub_contributions").collect();
  for (const row of all) {
    if (excludeId && row._id === excludeId) continue;
    if (
      row.confirmation_number &&
      normalizeConfirmation(row.confirmation_number).toLowerCase() === normalized
    ) {
      return row._id;
    }
    if (row.confirmations) {
      for (const c of row.confirmations) {
        if (
          normalizeConfirmation(c.confirmation_number).toLowerCase() ===
          normalized
        ) {
          return row._id;
        }
      }
    }
  }
  return null;
}

async function screenshotUrl(
  ctx: DbCtx,
  id: Id<"_storage"> | undefined,
): Promise<string | null> {
  if (!id) return null;
  return await ctx.storage.getUrl(id);
}

/**
 * Admin reconciliation inbox. Default filter: pending_verification, oldest first.
 * Items pending longer than VERIFICATION_FOLLOWUP_BUSINESS_DAYS are flagged overdue.
 */
export const listForReconciliation = query({
  args: {
    include_expired: v.optional(v.boolean()),
    status_filter: v.optional(
      v.union(
        v.literal("pending_verification"),
        v.literal("pending_payment"),
        v.literal("verified"),
        v.literal("rejected"),
        v.literal("expired"),
        v.literal("all_active"),
        v.literal("all"),
      ),
    ),
  },
  handler: async (ctx, args) => {
    await requireIdentity(ctx);
    const filter = args.status_filter ?? "pending_verification";
    const rows = await ctx.db.query("hub_contributions").collect();

    const out = [];
    for (const c of rows) {
      const status = effectivePaymentStatus(c);
      if (
        !args.include_expired &&
        status === "expired" &&
        filter !== "expired" &&
        filter !== "all"
      ) {
        continue;
      }
      if (filter === "all_active") {
        if (status === "expired") continue;
      } else if (filter !== "all" && status !== filter) {
        continue;
      }

      const member = await ctx.db.get(c.member_id);
      const collection = await ctx.db.get(c.collection_id);
      const pendingSince = c.donor_claimed_sent_at ?? c.logged_at;
      const businessDaysPending = businessDaysBetween(pendingSince, Date.now());
      const overdue =
        status === "pending_verification" &&
        businessDaysPending > VERIFICATION_FOLLOWUP_BUSINESS_DAYS;

      const primaryScreenshot = await screenshotUrl(
        ctx,
        c.confirmation_screenshot_id,
      );
      const confirmationLines = [];
      if (c.confirmations) {
        for (const line of c.confirmations) {
          confirmationLines.push({
            ...line,
            screenshot_url: await screenshotUrl(ctx, line.screenshot_id),
          });
        }
      }

      out.push({
        ...c,
        status,
        member_name: member?.name ?? "Unknown",
        member_its: member?.its_number ?? "",
        member_email: member?.email,
        member_designation: member?.designation,
        member_jamaat: c.jamaat ?? member?.jamaat,
        collection_title: collection?.title ?? "Unknown collection",
        collection_slug: collection?.slug ?? "",
        desired_memo: collection?.desired_memo ?? "",
        zelle_contact: collection?.zelle_contact ?? "",
        confirmation_screenshot_url: primaryScreenshot,
        confirmation_lines: confirmationLines,
        business_days_pending: businessDaysPending,
        overdue,
        verification_followup_days: VERIFICATION_FOLLOWUP_BUSINESS_DAYS,
      });
    }

    out.sort((a, b) => {
      const aT = a.donor_claimed_sent_at ?? a.logged_at;
      const bT = b.donor_claimed_sent_at ?? b.logged_at;
      return aT - bT;
    });
    return out;
  },
});

/** Fetch a payment request by id (member pay / status UI). */
export const getPayment = query({
  args: { contributionId: v.id("hub_contributions") },
  handler: async (ctx, { contributionId }) => {
    const c = await ctx.db.get(contributionId);
    if (!c) return null;
    const collection = await ctx.db.get(c.collection_id);
    const status = effectivePaymentStatus(c);
    const sla =
      collection?.verification_sla_business_days ??
      DEFAULT_VERIFICATION_SLA_BUSINESS_DAYS;
    return {
      _id: c._id,
      reference_code: c.reference_code,
      amount: c.amount,
      currency: c.currency ?? "USD",
      status,
      confirmation_number: c.confirmation_number,
      donor_claimed_sent_at: c.donor_claimed_sent_at,
      rejection_reason: c.rejection_reason,
      logged_at: c.logged_at,
      expires_at: c.expires_at,
      collection_title: collection?.title ?? "",
      zelle_contact: collection?.zelle_contact ?? "",
      desired_memo: collection?.desired_memo ?? "",
      amount_display: collection?.amount_display ?? "",
      verification_sla_business_days: sla,
      duplicate_confirmation_flag: c.duplicate_confirmation_flag,
      confirmations: c.confirmations,
      breakdown: c.breakdown,
    };
  },
});

/** Convex storage upload URL for confirmation screenshots. */
export const generateScreenshotUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    return await ctx.storage.generateUploadUrl();
  },
});

export const assertPaymentOwnedByIts = internalQuery({
  args: {
    contributionId: v.id("hub_contributions"),
    its: v.string(),
  },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.contributionId);
    if (!doc) return false;
    if (doc.logged_by_its && doc.logged_by_its === args.its) return true;
    const member = await ctx.db.get(doc.member_id);
    return member?.its_number === args.its;
  },
});

export const applySubmitConfirmation = internalMutation({
  args: {
    contributionId: v.id("hub_contributions"),
    confirmation_number: v.string(),
    confirmation_screenshot_id: v.optional(v.id("_storage")),
    donor_claimed_sent_at: v.number(),
    additional: v.optional(v.boolean()),
    partial_amount: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.contributionId);
    if (!doc) throw new Error("Payment request not found.");

    const status = effectivePaymentStatus(doc);
    if (status === "verified") {
      throw new Error("This payment is already verified.");
    }
    if (status === "expired") {
      throw new Error("This payment request has expired. Start a new one.");
    }
    if (status === "rejected") {
      throw new Error(
        "This payment was rejected. Start a new payment request if you still need to pay.",
      );
    }

    const confNum = normalizeConfirmation(args.confirmation_number);
    if (!confNum) {
      throw new Error(
        "Enter the confirmation number or last 4 digits from your bank.",
      );
    }

    const duplicateOf = await findDuplicateConfirmation(
      ctx,
      confNum,
      args.contributionId,
    );

    const line = {
      confirmation_number: confNum,
      screenshot_id: args.confirmation_screenshot_id,
      claimed_sent_at: args.donor_claimed_sent_at,
      amount: args.partial_amount,
      submitted_at: Date.now(),
    };

    if (
      args.additional &&
      (status === "pending_verification" || status === "pending_payment")
    ) {
      const existing = doc.confirmations ?? [];
      const seeded =
        existing.length === 0 && doc.confirmation_number
          ? [
              {
                confirmation_number: doc.confirmation_number,
                screenshot_id: doc.confirmation_screenshot_id,
                claimed_sent_at: doc.donor_claimed_sent_at ?? doc.logged_at,
                submitted_at: doc.donor_claimed_sent_at ?? doc.logged_at,
              },
              line,
            ]
          : [...existing, line];

      await ctx.db.patch(args.contributionId, {
        status: "pending_verification",
        confirmations: seeded,
        confirmation_number: doc.confirmation_number ?? confNum,
        confirmation_screenshot_id:
          doc.confirmation_screenshot_id ?? args.confirmation_screenshot_id,
        donor_claimed_sent_at:
          doc.donor_claimed_sent_at ?? args.donor_claimed_sent_at,
        duplicate_confirmation_flag:
          doc.duplicate_confirmation_flag || !!duplicateOf || undefined,
        payment_verified: false,
      });
      return {
        contributionId: args.contributionId,
        duplicate: !!duplicateOf,
        status: "pending_verification" as const,
      };
    }

    if (status !== "pending_payment" && status !== "pending_verification") {
      throw new Error(
        "This payment cannot accept confirmation in its current state.",
      );
    }

    await ctx.db.patch(args.contributionId, {
      status: "pending_verification",
      confirmation_number: confNum,
      confirmation_screenshot_id: args.confirmation_screenshot_id,
      donor_claimed_sent_at: args.donor_claimed_sent_at,
      confirmations: [line],
      duplicate_confirmation_flag: duplicateOf ? true : undefined,
      payment_verified: false,
      payment_verified_at: undefined,
      rejection_reason: undefined,
    });

    return {
      contributionId: args.contributionId,
      duplicate: !!duplicateOf,
      status: "pending_verification" as const,
    };
  },
});

/** Staff: mark verified after matching bank deposit. */
export const markVerified = mutation({
  args: {
    contributionId: v.id("hub_contributions"),
    staff_notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    const doc = await ctx.db.get(args.contributionId);
    if (!doc) throw new Error("Not found");
    const status = effectivePaymentStatus(doc);
    if (status === "expired") {
      throw new Error(
        "Expired payments cannot be verified. Ask the donor to resubmit.",
      );
    }
    await ctx.db.patch(args.contributionId, {
      status: "verified",
      payment_verified: true,
      payment_verified_at: Date.now(),
      verified_by: identity.subject,
      ...(args.staff_notes !== undefined
        ? { staff_notes: args.staff_notes.trim() || undefined }
        : {}),
      rejection_reason: undefined,
    });
  },
});

/** Staff: reject with a reason visible to the donor. */
export const markRejected = mutation({
  args: {
    contributionId: v.id("hub_contributions"),
    rejection_reason: v.string(),
    staff_notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    const doc = await ctx.db.get(args.contributionId);
    if (!doc) throw new Error("Not found");
    const reason = args.rejection_reason.trim();
    if (!reason) {
      throw new Error("A rejection reason is required (shown to the donor).");
    }
    await ctx.db.patch(args.contributionId, {
      status: "rejected",
      payment_verified: false,
      payment_verified_at: undefined,
      verified_by: identity.subject,
      rejection_reason: reason,
      ...(args.staff_notes !== undefined
        ? { staff_notes: args.staff_notes.trim() || undefined }
        : {}),
    });
  },
});

/** Staff: edit expected amount when donor sent a different amount. */
export const updateAmountExpected = mutation({
  args: {
    contributionId: v.id("hub_contributions"),
    amount: v.number(),
    staff_notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireIdentity(ctx);
    const doc = await ctx.db.get(args.contributionId);
    if (!doc) throw new Error("Not found");
    if (!Number.isFinite(args.amount) || args.amount <= 0) {
      throw new Error("Amount must be greater than zero.");
    }
    const noteAppend = args.staff_notes?.trim();
    const prevNotes = doc.staff_notes?.trim();
    await ctx.db.patch(args.contributionId, {
      amount: args.amount,
      ...(noteAppend
        ? {
            staff_notes: prevNotes
              ? `${prevNotes}\n${noteAppend}`
              : noteAppend,
          }
        : {}),
    });
  },
});

/** Staff: update staff-only notes without changing status. */
export const updateStaffNotes = mutation({
  args: {
    contributionId: v.id("hub_contributions"),
    staff_notes: v.string(),
  },
  handler: async (ctx, args) => {
    await requireIdentity(ctx);
    const doc = await ctx.db.get(args.contributionId);
    if (!doc) throw new Error("Not found");
    await ctx.db.patch(args.contributionId, {
      staff_notes: args.staff_notes.trim() || undefined,
    });
  },
});

/** Staff: link an additional confirmation (multi-transfer case). */
export const addConfirmationLine = mutation({
  args: {
    contributionId: v.id("hub_contributions"),
    confirmation_number: v.string(),
    claimed_sent_at: v.optional(v.number()),
    amount: v.optional(v.number()),
    screenshot_id: v.optional(v.id("_storage")),
  },
  handler: async (ctx, args) => {
    await requireIdentity(ctx);
    await ctx.runMutation(internal.zellePayments.applySubmitConfirmation, {
      contributionId: args.contributionId,
      confirmation_number: args.confirmation_number,
      confirmation_screenshot_id: args.screenshot_id,
      donor_claimed_sent_at: args.claimed_sent_at ?? Date.now(),
      additional: true,
      partial_amount: args.amount,
    });
  },
});

/** Cron: expire pending_payment past window. */
export const expirePendingPayments = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const rows = await ctx.db
      .query("hub_contributions")
      .withIndex("by_status", (q) => q.eq("status", "pending_payment"))
      .collect();

    let expired = 0;
    for (const row of rows) {
      const expiresAt =
        row.expires_at ??
        row.logged_at + msFromDays(PENDING_PAYMENT_EXPIRY_DAYS);
      if (now >= expiresAt) {
        await ctx.db.patch(row._id, { status: "expired" });
        expired += 1;
      }
    }
    return { expired };
  },
});

/**
 * Member-facing: submit confirmation after paying via Zelle.
 * Ownership checked by ITS against the payment record.
 */
export const submitConfirmation = action({
  args: {
    contributionId: v.id("hub_contributions"),
    its_number: v.string(),
    confirmation_number: v.string(),
    confirmation_screenshot_id: v.optional(v.id("_storage")),
    donor_claimed_sent_at: v.number(),
    additional: v.optional(v.boolean()),
    partial_amount: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    contributionId: Id<"hub_contributions">;
    duplicate: boolean;
    status: "pending_verification";
  }> => {
    const its = String(args.its_number ?? "").replace(/\D/g, "");
    if (!its) throw new Error("Invalid ITS number.");

    const owned = await ctx.runQuery(
      internal.zellePayments.assertPaymentOwnedByIts,
      {
        contributionId: args.contributionId,
        its,
      },
    );
    if (!owned) {
      throw new Error("This payment request does not belong to your account.");
    }

    return await ctx.runMutation(internal.zellePayments.applySubmitConfirmation, {
      contributionId: args.contributionId,
      confirmation_number: args.confirmation_number,
      confirmation_screenshot_id: args.confirmation_screenshot_id,
      donor_claimed_sent_at: args.donor_claimed_sent_at,
      additional: args.additional,
      partial_amount: args.partial_amount,
    });
  },
});

/** Re-export type for callers. */
export type HubContributionDoc = Doc<"hub_contributions">;
