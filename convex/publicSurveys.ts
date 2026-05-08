import { mutationGeneric as mutation, queryGeneric as query } from "convex/server";
import { v } from "convex/values";
import { isValidEmailFormat, normalizeEmail } from "./email";

export const getPublishedSurveyBySlug = query({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const form = await ctx.db
      .query("forms")
      .withIndex("by_slug", (q) => q.eq("slug", slug.trim().toLowerCase()))
      .first();
    if (!form || form.archived || !form.is_live) return null;

    const questions = await ctx.db
      .query("questions")
      .withIndex("by_form", (q) => q.eq("form_id", form._id))
      .collect();
    questions.sort((a, b) => a.order - b.order);

    return {
      form: {
        _id: form._id,
        title: form.title,
        description: form.description,
        slug: form.slug,
      },
      questions,
    };
  },
});

export const submitSurveyResponse = mutation({
  args: {
    slug: v.string(),
    answers: v.array(
      v.object({
        question_id: v.id("questions"),
        value: v.string(),
      })
    ),
  },
  handler: async (ctx, { slug, answers }) => {
    const form = await ctx.db
      .query("forms")
      .withIndex("by_slug", (q) => q.eq("slug", slug.trim().toLowerCase()))
      .first();
    if (!form || form.archived || !form.is_live) {
      throw new Error("This survey is not accepting responses.");
    }

    const questions = await ctx.db
      .query("questions")
      .withIndex("by_form", (q) => q.eq("form_id", form._id))
      .collect();
    const questionIds = new Set(questions.map((q) => q._id));
    const answerByQ = new Map(
      answers.map((a) => [a.question_id as string, a.value])
    );

    for (const a of answers) {
      if (!questionIds.has(a.question_id)) {
        throw new Error("Invalid question in submission.");
      }
    }

    for (const q of questions) {
      const val = answerByQ.get(q._id);
      if (!q.required) continue;
      if (q.type === "multiple_choice") {
        try {
          const parsed = JSON.parse(val ?? "[]") as unknown;
          if (!Array.isArray(parsed) || parsed.length === 0) {
            throw new Error(`Please answer: ${q.label}`);
          }
        } catch {
          throw new Error(`Please answer: ${q.label}`);
        }
      } else if (val === undefined || val === "") {
        throw new Error(`Please answer: ${q.label}`);
      }
    }

    for (const q of questions) {
      const raw = answerByQ.get(q._id);
      if (raw === undefined || raw === "") continue;
      validateAnswer(q.type, raw, q.options);
    }

    const emailQuestions = questions.filter((q) => q.type === "email");
    if (emailQuestions.length !== 1) {
      throw new Error("This survey is misconfigured (email question).");
    }
    const emailQ = emailQuestions[0];
    const emailRaw = answerByQ.get(emailQ._id);
    if (!emailRaw?.trim()) {
      throw new Error(`Please provide: ${emailQ.label}`);
    }
    const respondentEmail = normalizeEmail(emailRaw);
    if (!isValidEmailFormat(respondentEmail)) {
      throw new Error("Please enter a valid email address.");
    }

    const existingForForm = await ctx.db
      .query("submissions")
      .withIndex("by_form", (q) => q.eq("form_id", form._id))
      .collect();
    const duplicate = existingForForm.some(
      (s) => s.respondent_email === respondentEmail
    );
    if (duplicate) {
      throw new Error(
        "A response has already been submitted with this email address."
      );
    }

    const now = Date.now();
    const subId = await ctx.db.insert("submissions", {
      form_id: form._id,
      submitted_at: now,
      respondent_email: respondentEmail,
    });

    for (const q of questions) {
      const raw = answerByQ.get(q._id);
      if (raw === undefined || raw === "") {
        if (q.required) throw new Error(`Missing answer: ${q.label}`);
        continue;
      }
      await ctx.db.insert("answers", {
        submission_id: subId,
        question_id: q._id,
        value: raw,
      });
    }

    await ctx.db.patch(form._id, { updated_at: now });
    return subId;
  },
});

function validateAnswer(
  type:
    | "short_text"
    | "long_text"
    | "email"
    | "single_choice"
    | "multiple_choice"
    | "dropdown"
    | "yes_no"
    | "date"
    | "number",
  value: string,
  options?: string[]
) {
  switch (type) {
    case "short_text":
    case "long_text":
      return;
    case "email": {
      if (!isValidEmailFormat(value)) {
        throw new Error("Invalid email address.");
      }
      return;
    }
    case "number": {
      if (Number.isNaN(Number(value))) {
        throw new Error("Invalid number.");
      }
      return;
    }
    case "date": {
      if (Number.isNaN(Date.parse(value))) {
        throw new Error("Invalid date.");
      }
      return;
    }
    case "yes_no":
      if (value !== "yes" && value !== "no") {
        throw new Error("Invalid yes/no answer.");
      }
      return;
    case "single_choice":
    case "dropdown": {
      if (!options?.includes(value)) {
        throw new Error("Invalid option selected.");
      }
      return;
    }
    case "multiple_choice": {
      let parsed: string[];
      try {
        parsed = JSON.parse(value) as string[];
        if (!Array.isArray(parsed)) throw new Error();
      } catch {
        throw new Error("Invalid answer format.");
      }
      for (const p of parsed) {
        if (!options?.includes(p)) {
          throw new Error("Invalid option selected.");
        }
      }
      return;
    }
    default:
      return;
  }
}
