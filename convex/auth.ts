import type { GenericMutationCtx, GenericQueryCtx } from "convex/server";
import { ConvexError } from "convex/values";
import type { DataModel } from "./_generated/dataModel";

export async function requireIdentity(
  ctx: GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>
) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new ConvexError("Unauthorized");
  }
  return identity;
}
