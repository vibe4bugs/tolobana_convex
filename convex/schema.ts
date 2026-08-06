import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const questionType = v.union(
  v.literal("short_text"),
  v.literal("long_text"),
  v.literal("email"),
  v.literal("single_choice"),
  v.literal("multiple_choice"),
  v.literal("dropdown"),
  v.literal("yes_no"),
  v.literal("date"),
  v.literal("number")
);

export default defineSchema({
  forms: defineTable({
    title: v.string(),
    description: v.optional(v.string()),
    slug: v.string(),
    is_live: v.boolean(),
    created_at: v.number(),
    updated_at: v.number(),
    created_by: v.optional(v.string()),
    archived: v.optional(v.boolean()),
  })
    .index("by_slug", ["slug"])
    .index("by_created_by", ["created_by"]),

  questions: defineTable({
    form_id: v.id("forms"),
    order: v.number(),
    type: questionType,
    label: v.string(),
    help_text: v.optional(v.string()),
    required: v.boolean(),
    options: v.optional(v.array(v.string())),
  }).index("by_form", ["form_id"]),

  submissions: defineTable({
    form_id: v.id("forms"),
    submitted_at: v.number(),
    /** Normalized email for deduplication (one response per survey per email). */
    respondent_email: v.optional(v.string()),
  })
    .index("by_form", ["form_id"])
    .index("by_respondent_email", ["respondent_email"]),

  answers: defineTable({
    submission_id: v.id("submissions"),
    question_id: v.id("questions"),
    value: v.string(),
  })
    .index("by_submission", ["submission_id"])
    .index("by_question", ["question_id"]),

  announcements: defineTable({
    title: v.string(),
    body: v.string(),
    is_live: v.boolean(),
    created_at: v.number(),
    updated_at: v.number(),
    created_by: v.optional(v.string()),
    archived: v.optional(v.boolean()),
  }).index("by_live", ["is_live"]),

  /** Payment collection landing pages (QR → public URL; memo + amount shown to payers). */
  hub_collections: defineTable({
    title: v.string(),
    slug: v.string(),
    /** Shown on the public page, e.g. "$25.00" or "Suggested amount: $50". */
    amount_display: v.string(),
    /**
     * Optional legacy deep link (Venmo/PayPal/etc.). Zelle has no universal deep link —
     * prefer `zelle_contact` for the manual Zelle flow.
     */
    payment_url: v.string(),
    /**
     * Organization's Zelle-registered email or phone. Encoded as plain text in QR codes;
     * donors copy this into their bank's Zelle send flow.
     */
    zelle_contact: v.optional(v.string()),
    /**
     * Optional campaign memo hint. Per-payment `reference_code` (REF-####) is the
     * primary memo donors are asked to include when their bank supports notes.
     */
    desired_memo: v.string(),
    /**
     * Business days shown to donors after confirmation ("we'll verify within X days").
     * Defaults to 3 when unset.
     */
    verification_sla_business_days: v.optional(v.number()),
    is_live: v.boolean(),
    /**
     * Who sees this collection in the member portal Hub.
     * Missing / undefined treated as `"leadership"` for older rows.
     */
    member_portal_audience: v.optional(
      v.union(v.literal("all_members"), v.literal("leadership")),
    ),
    created_at: v.number(),
    updated_at: v.number(),
    created_by: v.optional(v.string()),
    archived: v.optional(v.boolean()),
  }).index("by_slug", ["slug"]),

  /**
   * Members (ITS login). Seeded / managed by admins; member portal calls `members.login`.
   */
  members: defineTable({
    its_number: v.string(),
    name: v.string(),
    /** Lowercased trimmed for `by_email` (import + survey submit use `normalizeEmail`). */
    email: v.optional(v.string()),
    /** TKMI roster Designation (e.g. Member, Treasurer) — used for leadership-only Hub campaigns. */
    designation: v.optional(v.string()),
    /** TKMI Jamaat (e.g. HOUSTON TX). */
    jamaat: v.optional(v.string()),
    /** TKMI Coordinator name — POC who oversees this member's jamaat. */
    coordinator: v.optional(v.string()),
    created_at: v.number(),
  })
    .index("by_its_number", ["its_number"])
    .index("by_email", ["email"])
    .index("by_coordinator", ["coordinator"])
    .index("by_jamaat", ["jamaat"]),

  /**
   * Member-reported Zelle payment requests toward a hub_collection.
   *
   * Status machine: pending_payment → pending_verification → verified | rejected
   * (or expired if never claimed). Donor confirmation is a claim, not proof —
   * staff must match against the actual bank deposit.
   *
   * Leadership chapter pledges: one row per Zelle/payment from the secretary.
   * `amount` is the payment total; `breakdown` lists who pledged how much (must sum to amount).
   * Personal / all-members logs: single amount, no breakdown.
   */
  hub_contributions: defineTable({
    collection_id: v.id("hub_collections"),
    /** Payer / primary attribution — secretary for chapter batches; self for personal logs. */
    member_id: v.id("members"),
    /** Amount expected (editable by staff during reconciliation if donor sent a different amount). */
    amount: v.number(),
    currency: v.optional(v.string()),
    /**
     * Unique short code shown to the donor (e.g. REF-8321) for the Zelle memo/note field.
     * Best-effort — not all bank Zelle UIs support memos.
     */
    reference_code: v.optional(v.string()),
    /**
     * pending_payment | pending_verification | verified | rejected | expired
     * Legacy rows without status: treat payment_verified as verified, else pending_verification.
     */
    status: v.optional(
      v.union(
        v.literal("pending_payment"),
        v.literal("pending_verification"),
        v.literal("verified"),
        v.literal("rejected"),
        v.literal("expired"),
      ),
    ),
    note: v.optional(v.string()),
    logged_at: v.number(),
    /** Snapshot of contributor jamaat at log time (for POC reporting). */
    jamaat: v.optional(v.string()),
    /**
     * Who submitted the portal log (e.g. chapter secretary).
     * For chapter batches this matches the payer (member_id).
     */
    logged_by_its: v.optional(v.string()),
    logged_by_name: v.optional(v.string()),
    /**
     * Per-member pledge lines for chapter batches. Sum must equal `amount`.
     * Omitted for simple personal contributions.
     */
    breakdown: v.optional(
      v.array(
        v.object({
          its_number: v.string(),
          name: v.string(),
          email: v.optional(v.string()),
          amount: v.number(),
          jamaat: v.optional(v.string()),
        }),
      ),
    ),
    /** Primary confirmation number / last-4 from the donor's bank (format varies). */
    confirmation_number: v.optional(v.string()),
    /** Screenshot of Zelle confirmation (Convex storage). */
    confirmation_screenshot_id: v.optional(v.id("_storage")),
    /** When the donor says they sent the Zelle transfer. */
    donor_claimed_sent_at: v.optional(v.number()),
    /**
     * Additional confirmation submissions when a donor sends multiple partial
     * transfers toward one payment record. Sum of optional per-line amounts
     * is informational for staff; `amount` remains the expected total.
     */
    confirmations: v.optional(
      v.array(
        v.object({
          confirmation_number: v.string(),
          screenshot_id: v.optional(v.id("_storage")),
          claimed_sent_at: v.number(),
          amount: v.optional(v.number()),
          submitted_at: v.number(),
        }),
      ),
    ),
    /** Set when the same confirmation_number appears on another payment record. */
    duplicate_confirmation_flag: v.optional(v.boolean()),
    /** Staff-only free text (not shown to donor). */
    staff_notes: v.optional(v.string()),
    /** Required when status → rejected; visible to the donor. */
    rejection_reason: v.optional(v.string()),
    /** When pending_payment should auto-expire if never claimed. */
    expires_at: v.optional(v.number()),
    /**
     * Reserved for a future Plaid (or similar) auto-reconciliation job.
     * Do not populate in this phase.
     */
    matched_bank_transaction_id: v.optional(v.string()),
    /** Admin confirmed matching payment was received (mirrors status === verified). */
    payment_verified: v.optional(v.boolean()),
    payment_verified_at: v.optional(v.number()),
    /** Clerk subject (or staff id) who verified. */
    verified_by: v.optional(v.string()),
    /** Admin personally forwarded the receipt to the contributor. */
    receipt_forwarded_at: v.optional(v.number()),
  })
    .index("by_collection", ["collection_id"])
    .index("by_member", ["member_id"])
    .index("by_collection_and_member", ["collection_id", "member_id"])
    .index("by_logged_at", ["logged_at"])
    .index("by_status", ["status"])
    .index("by_reference_code", ["reference_code"])
    .index("by_confirmation_number", ["confirmation_number"]),
});
