import { mutationGeneric as mutation, queryGeneric as query } from "convex/server";
import { v } from "convex/values";
import { requireIdentity } from "./auth";
import { questionType } from "./schema";

function assertSingleRequiredEmailQuestion(
  questions: { type: string; required: boolean }[]
) {
  const emails = questions.filter((q) => q.type === "email");
  if (emails.length !== 1) {
    throw new Error(
      "Add exactly one Email question and mark it required before this survey can go live."
    );
  }
  if (!emails[0].required) {
    throw new Error("The Email question must be required.");
  }
}

const slugRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function normalizeSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export const listSurveys = query({
  handler: async (ctx) => {
    await requireIdentity(ctx);
    const forms = await ctx.db.query("forms").collect();
    forms.sort((a, b) => b._creationTime - a._creationTime);
    const active = forms.filter((f) => !f.archived);
    const out = [];
    for (const f of active) {
      const subs = await ctx.db
        .query("submissions")
        .withIndex("by_form", (q) => q.eq("form_id", f._id))
        .collect();
      out.push({
        ...f,
        responseCount: subs.length,
      });
    }
    return out;
  },
});

export const getSurvey = query({
  args: { formId: v.id("forms") },
  handler: async (ctx, { formId }) => {
    await requireIdentity(ctx);
    const form = await ctx.db.get(formId);
    if (!form || form.archived) return null;
    const questions = await ctx.db
      .query("questions")
      .withIndex("by_form", (q) => q.eq("form_id", formId))
      .collect();
    questions.sort((a, b) => a.order - b.order);
    const subs = await ctx.db
      .query("submissions")
      .withIndex("by_form", (q) => q.eq("form_id", formId))
      .collect();
    return { form, questions, responseCount: subs.length };
  },
});

const questionInput = v.object({
  label: v.string(),
  help_text: v.optional(v.string()),
  required: v.boolean(),
  type: questionType,
  options: v.optional(v.array(v.string())),
});

export const createSurvey = mutation({
  args: {
    title: v.string(),
    description: v.optional(v.string()),
    slug: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    const now = Date.now();
    let slug =
      args.slug?.trim() ? normalizeSlug(args.slug) : normalizeSlug(args.title);
    if (!slug) slug = `survey-${now}`;
    if (!slugRegex.test(slug)) {
      throw new Error(
        "Slug must be lowercase letters, numbers, and hyphens only."
      );
    }
    const existing = await ctx.db
      .query("forms")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .first();
    if (existing) {
      throw new Error("A survey with this slug already exists.");
    }
    const id = await ctx.db.insert("forms", {
      title: args.title.trim() || "Untitled survey",
      description: args.description?.trim(),
      slug,
      is_live: false,
      created_at: now,
      updated_at: now,
      created_by: identity.subject,
    });
    return id;
  },
});

export const updateSurveyMeta = mutation({
  args: {
    formId: v.id("forms"),
    title: v.string(),
    description: v.optional(v.string()),
    slug: v.string(),
  },
  handler: async (ctx, { formId, title, description, slug }) => {
    await requireIdentity(ctx);
    const form = await ctx.db.get(formId);
    if (!form || form.archived) throw new Error("Not found");
    const normalized = normalizeSlug(slug);
    if (!normalized || !slugRegex.test(normalized)) {
      throw new Error(
        "Slug must be lowercase letters, numbers, and hyphens only."
      );
    }
    if (normalized !== form.slug) {
      const existing = await ctx.db
        .query("forms")
        .withIndex("by_slug", (q) => q.eq("slug", normalized))
        .first();
      if (existing && existing._id !== formId) {
        throw new Error("That slug is already in use.");
      }
    }
    await ctx.db.patch(formId, {
      title: title.trim() || "Untitled survey",
      description: description?.trim(),
      slug: normalized,
      updated_at: Date.now(),
    });
  },
});

export const setSurveyLive = mutation({
  args: {
    formId: v.id("forms"),
    is_live: v.boolean(),
  },
  handler: async (ctx, { formId, is_live }) => {
    await requireIdentity(ctx);
    const form = await ctx.db.get(formId);
    if (!form || form.archived) throw new Error("Not found");

    if (is_live) {
      const qs = await ctx.db
        .query("questions")
        .withIndex("by_form", (q) => q.eq("form_id", formId))
        .collect();
      assertSingleRequiredEmailQuestion(qs);
    }

    await ctx.db.patch(formId, {
      is_live,
      updated_at: Date.now(),
    });
  },
});

export const saveSurveyQuestions = mutation({
  args: {
    formId: v.id("forms"),
    questions: v.array(questionInput),
  },
  handler: async (ctx, { formId, questions }) => {
    await requireIdentity(ctx);
    const form = await ctx.db.get(formId);
    if (!form || form.archived) throw new Error("Not found");

    const existing = await ctx.db
      .query("questions")
      .withIndex("by_form", (q) => q.eq("form_id", formId))
      .collect();
    for (const q of existing) {
      await ctx.db.delete(q._id);
    }

    const emailQs = questions.filter((q) => q.type === "email");
    if (emailQs.length > 1) {
      throw new Error("Only one Email question is allowed per survey.");
    }

    let order = 0;
    for (const q of questions) {
      const needsOptions =
        q.type === "single_choice" ||
        q.type === "multiple_choice" ||
        q.type === "dropdown";
      if (needsOptions && (!q.options || q.options.length === 0)) {
        throw new Error(`Question "${q.label}" needs at least one option.`);
      }
      await ctx.db.insert("questions", {
        form_id: formId,
        order: order++,
        type: q.type,
        label: q.label.trim(),
        help_text: q.help_text?.trim(),
        required: q.required,
        options: needsOptions ? q.options : undefined,
      });
    }
    await ctx.db.patch(formId, { updated_at: Date.now() });
  },
});

export const archiveSurvey = mutation({
  args: { formId: v.id("forms") },
  handler: async (ctx, { formId }) => {
    await requireIdentity(ctx);
    const form = await ctx.db.get(formId);
    if (!form) throw new Error("Not found");
    await ctx.db.patch(formId, {
      archived: true,
      is_live: false,
      updated_at: Date.now(),
    });
  },
});

export const listSubmissionsForSurvey = query({
  args: { formId: v.id("forms") },
  handler: async (ctx, { formId }) => {
    await requireIdentity(ctx);
    const form = await ctx.db.get(formId);
    if (!form || form.archived) return null;

    const questions = await ctx.db
      .query("questions")
      .withIndex("by_form", (q) => q.eq("form_id", formId))
      .collect();
    questions.sort((a, b) => a.order - b.order);

    const submissions = await ctx.db
      .query("submissions")
      .withIndex("by_form", (q) => q.eq("form_id", formId))
      .collect();
    submissions.sort((a, b) => b.submitted_at - a.submitted_at);

    const rows = [];
    for (const sub of submissions) {
      const answers = await ctx.db
        .query("answers")
        .withIndex("by_submission", (q) => q.eq("submission_id", sub._id))
        .collect();
      const byQ: Record<string, string> = {};
      for (const a of answers) {
        byQ[a.question_id] = a.value;
      }
      rows.push({
        submission: sub,
        answersByQuestionId: byQ,
      });
    }

    return { form, questions, rows };
  },
});

// ---------------------------------------------------------------------------
// Member portal (no Clerk): same module path `api.surveys.*` as member app.
// ---------------------------------------------------------------------------

/** List live, non-archived forms for the member portal. */
export const listLive = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("forms")
      .filter((q) =>
        q.and(q.eq(q.field("is_live"), true), q.neq(q.field("archived"), true)),
      )
      .collect();
  },
});

/** Published survey by slug for authenticated members. */
export const getBySlug = query({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    const form = await ctx.db
      .query("forms")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .unique();

    if (!form || !form.is_live || form.archived) {
      return null;
    }

    return form;
  },
});

export const getQuestions = query({
  args: { formId: v.id("forms") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("questions")
      .withIndex("by_form", (q) => q.eq("form_id", args.formId))
      .collect()
      .then((qs) => qs.sort((a, b) => a.order - b.order));
  },
});

/** Member survey submit; dedupes by respondent_email when provided. */
export const submit = mutation({
  args: {
    formId: v.id("forms"),
    respondent_email: v.optional(v.string()),
    answers: v.array(
      v.object({
        question_id: v.id("questions"),
        value: v.string(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const form = await ctx.db.get(args.formId);
    if (!form || !form.is_live || form.archived) {
      throw new Error("This survey is no longer accepting responses.");
    }

    if (args.respondent_email) {
      const existing = await ctx.db
        .query("submissions")
        .withIndex("by_respondent_email", (q) =>
          q.eq("respondent_email", args.respondent_email),
        )
        .filter((q) => q.eq(q.field("form_id"), args.formId))
        .first();

      if (existing) {
        throw new Error("You have already submitted this survey.");
      }
    }

    const submissionId = await ctx.db.insert("submissions", {
      form_id: args.formId,
      respondent_email: args.respondent_email,
      submitted_at: Date.now(),
    });

    for (const answer of args.answers) {
      await ctx.db.insert("answers", {
        submission_id: submissionId,
        question_id: answer.question_id,
        value: answer.value,
      });
    }

    return submissionId;
  },
});

export const getOwnSubmission = query({
  args: { formId: v.id("forms"), email: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("submissions")
      .withIndex("by_respondent_email", (q) =>
        q.eq("respondent_email", args.email),
      )
      .filter((q) => q.eq(q.field("form_id"), args.formId))
      .unique();
  },
});
