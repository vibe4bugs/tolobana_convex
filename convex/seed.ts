import { mutationGeneric as mutation } from "convex/server";
import { normalizeEmail } from "./email";

/** Dev-only convenience seed; do not expose to untrusted callers in production. */
export const seed = mutation({
  args: {},
  handler: async (ctx) => {
    const member1 = await ctx.db.insert("members", {
      its_number: "12345678",
      name: "John Doe",
      email: normalizeEmail("john@example.com"),
      created_at: Date.now(),
    });

    const member2 = await ctx.db.insert("members", {
      its_number: "87654321",
      name: "Jane Smith",
      email: normalizeEmail("jane@example.com"),
      created_at: Date.now(),
    });

    await ctx.db.insert("announcements", {
      title: "Welcome to the Tolobana Portal",
      body: "We are excited to launch our new member portal. Here you can find the latest announcements, participate in surveys, and track our community hub collections in real-time.",
      is_live: true,
      created_at: Date.now(),
      updated_at: Date.now(),
    });

    await ctx.db.insert("announcements", {
      title: "Upcoming Community Iftar",
      body: "Join us this Friday for a community iftar at the main hall. Please RSVP via the surveys tab if you haven't already.",
      is_live: true,
      created_at: Date.now() - 86400000,
      updated_at: Date.now() - 86400000,
    });

    const hub1 = await ctx.db.insert("hub_collections", {
      title: "Ramadan Food Drive",
      slug: "ramadan-food-drive",
      amount_display: "Target: $5,000",
      desired_memo: "FOOD-DRIVE-2026",
      payment_url: "https://zelle.example.com/pay?to=tolobana&memo=FOOD-DRIVE-2026",
      is_live: true,
      created_at: Date.now(),
      updated_at: Date.now(),
    });

    await ctx.db.insert("hub_collections", {
      title: "Education Scholarship Fund",
      slug: "scholarship-fund",
      amount_display: "Target: $10,000",
      desired_memo: "SCHOLARSHIP-2026",
      payment_url: "https://zelle.example.com/pay?to=tolobana&memo=SCHOLARSHIP-2026",
      is_live: true,
      created_at: Date.now(),
      updated_at: Date.now(),
    });

    const form1 = await ctx.db.insert("forms", {
      title: "Community Feedback 2026",
      slug: "feedback-2026",
      description:
        "Help us improve our community services by providing your honest feedback.",
      is_live: true,
      created_at: Date.now(),
      updated_at: Date.now(),
    });

    await ctx.db.insert("questions", {
      form_id: form1,
      label: "How satisfied are you with our current programs?",
      type: "single_choice",
      options: ["Very Satisfied", "Satisfied", "Neutral", "Unsatisfied"],
      order: 1,
      required: true,
    });

    await ctx.db.insert("questions", {
      form_id: form1,
      label: "What new services would you like to see?",
      type: "long_text",
      order: 2,
      required: false,
    });

    await ctx.db.insert("questions", {
      form_id: form1,
      label: "Would you like to volunteer for future events?",
      type: "yes_no",
      order: 3,
      required: true,
    });

    await ctx.db.insert("hub_contributions", {
      collection_id: hub1,
      member_id: member1,
      amount: 150,
      note: "For the community!",
      logged_at: Date.now(),
    });

    await ctx.db.insert("hub_contributions", {
      collection_id: hub1,
      member_id: member2,
      amount: 100,
      logged_at: Date.now() - 3600000,
    });

    return "Seeding completed successfully!";
  },
});
