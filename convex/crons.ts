import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

/** Auto-expire payment requests stuck in pending_payment past the configured window. */
crons.interval(
  "expire pending zelle payments",
  { hours: 6 },
  internal.zellePayments.expirePendingPayments,
  {},
);

export default crons;
