import { actionGeneric as action } from "convex/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";

async function deliverCode(email: string, code: string): Promise<string | undefined> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    if (process.env.AUTH_LOG_SIGN_IN_CODE === "1") {
      console.log(`TOLOBA_SIGN_IN_CODE ${code}`);
      return code;
    }
    throw new ConvexError(
      "Sign-in email is not configured yet. Add RESEND_API_KEY on the member deployment.",
    );
  }

  const from = process.env.AUTH_EMAIL_FROM;
  if (!from) {
    throw new ConvexError(
      "Sign-in email is not configured yet. Add AUTH_EMAIL_FROM on the member deployment.",
    );
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [email],
      subject: "Your Toloba NA sign-in code",
      text: `Your Toloba NA sign-in code is ${code}. It expires in 10 minutes. If you did not request it, you can ignore this email.`,
    }),
  });
  if (!response.ok) {
    let detail = "";
    try {
      const body = (await response.json()) as { message?: unknown };
      if (typeof body.message === "string") detail = body.message;
    } catch {
      detail = "";
    }
    throw new ConvexError(
      detail
        ? `Could not send the sign-in email. ${detail}`
        : "Could not send the sign-in email. Try again in a minute.",
    );
  }
  return undefined;
}

/**
 * Start sign-in for an ITS that is already on the roster.
 * Sends a code to that member's email. Does not create a session.
 */
export const requestSignInCode = action({
  args: { its_number: v.string() },
  handler: async (ctx, args): Promise<{ masked_email: string; dev_code?: string }> => {
    const issued = await ctx.runMutation(internal.memberSignIn.issueSignInCode, {
      its_number: args.its_number,
    });
    if (!("code" in issued) || !issued.code || !("email" in issued) || !issued.email) {
      return { masked_email: issued.masked_email };
    }

    try {
      const dev_code = await deliverCode(issued.email, issued.code);
      return dev_code
        ? { masked_email: issued.masked_email, dev_code }
        : { masked_email: issued.masked_email };
    } catch (error) {
      await ctx.runMutation(internal.memberSignIn.clearSignInCode, {
        its_number: args.its_number,
      });
      throw error;
    }
  },
});
