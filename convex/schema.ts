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
    /** Where the payer completes payment (Venmo/PayPal/bank portal deep link, etc.). */
    payment_url: v.string(),
    /** Exact memo text payers should include — surfaced prominently on the public page. */
    desired_memo: v.string(),
    is_live: v.boolean(),
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
    email: v.optional(v.string()),
    created_at: v.number(),
  }).index("by_its_number", ["its_number"]),

  /**
   * Member-reported contributions toward a hub_collection.
   */
  hub_contributions: defineTable({
    collection_id: v.id("hub_collections"),
    member_id: v.id("members"),
    amount: v.number(),
    note: v.optional(v.string()),
    logged_at: v.number(),
  })
    .index("by_collection", ["collection_id"])
    .index("by_member", ["member_id"])
    .index("by_collection_and_member", ["collection_id", "member_id"]),
});
