/**
 * Configurable thresholds for the manual Zelle payment / reconciliation flow.
 * Not secrets — safe to change per deployment via code or future app_settings.
 */

/** Days a payment may sit in `pending_payment` before auto-expiring. */
export const PENDING_PAYMENT_EXPIRY_DAYS = 14;

/**
 * Business days a claim may sit in `pending_verification` before the admin
 * inbox flags it for follow-up.
 */
export const VERIFICATION_FOLLOWUP_BUSINESS_DAYS = 5;

/** Default SLA copy shown to donors after they submit confirmation. */
export const DEFAULT_VERIFICATION_SLA_BUSINESS_DAYS = 3;

export const paymentStatusValidator = [
  "pending_payment",
  "pending_verification",
  "verified",
  "rejected",
  "expired",
] as const;

export type PaymentStatus = (typeof paymentStatusValidator)[number];

/** Resolve status for legacy rows that only have `payment_verified`. */
export function effectivePaymentStatus(doc: {
  status?: PaymentStatus;
  payment_verified?: boolean;
}): PaymentStatus {
  if (doc.status) return doc.status;
  if (doc.payment_verified) return "verified";
  // Pre-reconciliation logs were self-reported claims awaiting staff review.
  return "pending_verification";
}

export function msFromDays(days: number): number {
  return days * 24 * 60 * 60 * 1000;
}

/** Count business days (Mon–Fri) between two timestamps. */
export function businessDaysBetween(fromMs: number, toMs: number): number {
  if (toMs <= fromMs) return 0;
  let count = 0;
  const d = new Date(fromMs);
  d.setHours(0, 0, 0, 0);
  const end = new Date(toMs);
  end.setHours(0, 0, 0, 0);
  while (d < end) {
    d.setDate(d.getDate() + 1);
    const day = d.getDay();
    if (day !== 0 && day !== 6) count += 1;
  }
  return count;
}

export function formatMoney(amount: number, currency = "USD"): string {
  return amount.toLocaleString("en-US", { style: "currency", currency });
}

export function defaultExpiresAt(fromMs = Date.now()): number {
  return fromMs + msFromDays(PENDING_PAYMENT_EXPIRY_DAYS);
}

/**
 * Allocate a unique REF-#### for a payment request.
 * Pass MutationCtx from the caller (kept here to avoid circular hub ↔ zellePayments imports).
 */
export async function allocateReferenceCode(ctx: {
  db: {
    query: (table: "hub_contributions") => {
      withIndex: (
        name: "by_reference_code",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fn: (q: any) => any,
      ) => { unique: () => Promise<{ _id: string } | null> };
    };
  };
}): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const n = Math.floor(1000 + Math.random() * 9000);
    const code = `REF-${n}`;
    const existing = await ctx.db
      .query("hub_contributions")
      .withIndex("by_reference_code", (q) => q.eq("reference_code", code))
      .unique();
    if (!existing) return code;
  }
  return `REF-${Date.now().toString().slice(-6)}`;
}
