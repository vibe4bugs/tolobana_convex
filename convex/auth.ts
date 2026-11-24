import { ConvexCredentials } from "@convex-dev/auth/providers/ConvexCredentials";
import {
  convexAuth,
  createAccount,
  retrieveAccount,
} from "@convex-dev/auth/server";
import { internal } from "./_generated/api";

/**
 * Member sign-in. The client sends an ITS number and the email code.
 * `authorize` accepts the pair only after `memberSignIn.consumeCode`
 * has checked the roster and the code.
 */
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    ConvexCredentials({
      id: "its",
      authorize: async (credentials, ctx) => {
        const its_number =
          typeof credentials.its_number === "string" ? credentials.its_number : "";
        const code = typeof credentials.code === "string" ? credentials.code : "";
        const member = await ctx.runMutation(internal.memberSignIn.consumeCode, {
          its_number,
          code,
        });

        try {
          const existing = await retrieveAccount(ctx, {
            provider: "its",
            account: { id: member.its_number },
          });
          return { userId: existing.user._id };
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "InvalidAccountId") {
            throw error;
          }
        }

        const created = await createAccount(ctx, {
          provider: "its",
          account: { id: member.its_number },
          profile: {
            name: member.name,
            email: member.email,
            emailVerificationTime: Date.now(),
          },
        });
        return { userId: created.user._id };
      },
    }),
  ],
});
