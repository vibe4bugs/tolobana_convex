/** Trim, lowercase — used for deduplication and index lookup. */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isValidEmailFormat(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/** Collapse whitespace + lowercase for matching Coordinator names across roster rows. */
export function normalizePersonName(raw: string | undefined | null): string {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}
