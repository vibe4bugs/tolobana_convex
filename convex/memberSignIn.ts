import { internalMutationGeneric as internalMutation } from "convex/server";
import { ConvexError, v } from "convex/values";
import { normalizeEmail } from "./email";

const CODE_TTL_MS = 10 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;

function normalizeIts(raw: string): string {
  return String(raw ?? "").replace(/\D/g, "");
}

function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "your email";
  return `${email.slice(0, 1)}•••${email.slice(at)}`;
}

async function hashCode(its: string, code: string): Promise<string> {
  const pepper = process.env.JWT_PRIVATE_KEY ?? "toloba-sign-in";
  const data = new TextEncoder().encode(`${pepper}:${its}:${code}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function hashesMatch(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let i = 0; i < left.length; i += 1) {
    mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return mismatch === 0;
}

function randomCode(): string {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return String(bytes[0]! % 1_000_000).padStart(6, "0");
}

/**
 * Store a fresh code for an ITS already on the roster.
 * Returns the address and code to the action that sends the email.
 * A request inside the cooldown returns the masked address only.
 */
export const issueSignInCode = internalMutation({
  args: { its_number: v.string() },
  handler: async (ctx, args) => {
    const its_number = normalizeIts(args.its_number);
    if (!its_number) {
      throw new ConvexError("Enter an ITS number.");
    }

    const member = await ctx.db
      .query("members")
      .withIndex("by_its_number", (q) => q.eq("its_number", its_number))
      .unique();
    if (!member) {
      throw new ConvexError("ITS number not recognised. Contact your administrator.");
    }

    const email = member.email?.trim() ? normalizeEmail(member.email) : undefined;
    if (!email) {
      throw new ConvexError(
        "This ITS number has no email on file. Contact your administrator.",
      );
    }

    const now = Date.now();
    const existing = await ctx.db
      .query("sign_in_codes")
      .withIndex("by_its_number", (q) => q.eq("its_number", its_number))
      .unique();
    if (existing && now - existing.sent_at < RESEND_COOLDOWN_MS) {
      return { masked_email: maskEmail(email) };
    }

    const code = randomCode();
    const code_hash = await hashCode(its_number, code);
    if (existing) {
      await ctx.db.patch(existing._id, {
        code_hash,
        expires_at: now + CODE_TTL_MS,
        attempts: 0,
        sent_at: now,
      });
    } else {
      await ctx.db.insert("sign_in_codes", {
        its_number,
        code_hash,
        expires_at: now + CODE_TTL_MS,
        attempts: 0,
        sent_at: now,
      });
    }

    return { masked_email: maskEmail(email), email, code };
  },
});

/** Drop a code when the email send fails, so the next attempt is not on cooldown. */
export const clearSignInCode = internalMutation({
  args: { its_number: v.string() },
  handler: async (ctx, args) => {
    const its_number = normalizeIts(args.its_number);
    const pending = await ctx.db
      .query("sign_in_codes")
      .withIndex("by_its_number", (q) => q.eq("its_number", its_number))
      .unique();
    if (pending) await ctx.db.delete(pending._id);
  },
});

/** Check a code and delete it. Called only from the sign-in action. */
export const consumeCode = internalMutation({
  args: {
    its_number: v.string(),
    code: v.string(),
  },
  handler: async (ctx, args) => {
    const its_number = normalizeIts(args.its_number);
    const code = String(args.code ?? "").replace(/\D/g, "");
    if (!its_number || code.length !== 6) {
      throw new ConvexError("That code is not valid.");
    }

    const pending = await ctx.db
      .query("sign_in_codes")
      .withIndex("by_its_number", (q) => q.eq("its_number", its_number))
      .unique();
    if (!pending) {
      throw new ConvexError("Request a code first.");
    }
    if (pending.expires_at < Date.now()) {
      await ctx.db.delete(pending._id);
      throw new ConvexError("That code has expired. Request a new one.");
    }

    const expected = await hashCode(its_number, code);
    if (!hashesMatch(expected, pending.code_hash)) {
      const attempts = pending.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        await ctx.db.delete(pending._id);
        throw new ConvexError("That code is no longer valid. Request a new one.");
      }
      await ctx.db.patch(pending._id, { attempts });
      throw new ConvexError("That code is not valid.");
    }

    const member = await ctx.db
      .query("members")
      .withIndex("by_its_number", (q) => q.eq("its_number", its_number))
      .unique();
    if (!member?.email) {
      await ctx.db.delete(pending._id);
      throw new ConvexError("ITS number not recognised. Contact your administrator.");
    }

    await ctx.db.delete(pending._id);
    return {
      its_number: member.its_number,
      name: member.name,
      email: normalizeEmail(member.email),
    };
  },
});
