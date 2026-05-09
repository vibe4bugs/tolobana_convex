#!/usr/bin/env node
/**
 * Import member rows from an Excel file into Convex `members` (member deployment).
 *
 * Prerequisites:
 *   - Set MEMBERS_IMPORT_SECRET on the target Convex deployment (Dashboard → Settings → Environment Variables).
 *   - Same value in your shell or a local `.env` file (dotenv not required if you export vars manually).
 *
 * Usage:
 *   MEMBER_CONVEX_URL="https://YOUR_MEMBER_DEPLOYMENT.convex.cloud" \
 *   MEMBERS_IMPORT_SECRET="your-secret" \
 *   node scripts/import-members-from-xlsx.mjs ./path/to/members.xlsx
 *
 * Expected columns (header row); names are matched case-insensitively:
 *   - itsId (or its_number / ITS / ITS ID / its number) — required
 *   - name (or full name) — required
 *   - email — optional
 *
 * Tip: In Excel, format the ITS column as **Text** so long IDs are not rounded.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { ConvexHttpClient } from "convex/browser";
import * as XLSX from "xlsx";
import { api } from "../convex/_generated/api.js";

const BATCH_SIZE = 250;

function normalizeHeaderKey(key) {
  return String(key ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

function pickIts(row) {
  const entries = Object.entries(row);
  const preferred = [
    "itsid",
    "itsnumber",
    "its",
    "itsno",
    "its_no",
    "its_number",
  ];
  for (const want of preferred) {
    const hit = entries.find(([k]) => normalizeHeaderKey(k) === want);
    if (hit && hit[1] !== undefined && hit[1] !== "") return hit[1];
  }
  const fuzzy = entries.find(([k]) => {
    const nk = normalizeHeaderKey(k);
    return nk.includes("its") && nk.includes("id");
  });
  if (fuzzy && fuzzy[1] !== undefined && fuzzy[1] !== "") return fuzzy[1];
  return "";
}

function pickName(row) {
  const entries = Object.entries(row);
  const preferred = ["name", "fullname", "membername", "full name"];
  for (const want of preferred) {
    const hit = entries.find(([k]) => normalizeHeaderKey(k) === want);
    if (hit && String(hit[1]).trim()) return String(hit[1]).trim();
  }
  return "";
}

function pickEmail(row) {
  const entries = Object.entries(row);
  const hit = entries.find(([k]) => normalizeHeaderKey(k) === "email");
  if (hit && String(hit[1]).trim()) return String(hit[1]).trim();
  return undefined;
}

function cellToString(val) {
  if (val == null || val === "") return "";
  if (typeof val === "number") {
    if (!Number.isFinite(val)) return "";
    return String(Math.round(val));
  }
  return String(val).trim();
}

async function main() {
  const filePath = process.argv[2];
  const convexUrl =
    process.env.MEMBER_CONVEX_URL ?? process.env.CONVEX_URL;
  const secret = process.env.MEMBERS_IMPORT_SECRET;

  if (!filePath) {
    console.error(
      "Usage: MEMBER_CONVEX_URL=... MEMBERS_IMPORT_SECRET=... node scripts/import-members-from-xlsx.mjs <file.xlsx>",
    );
    process.exit(1);
  }
  if (!convexUrl) {
    console.error(
      "Missing MEMBER_CONVEX_URL (your member deployment — same host as VITE_CONVEX_URL_MEMBER). Legacy CONVEX_URL is still accepted.",
    );
    console.error(
      "Tip: In zsh/bash, either prefix the command on one line (see README), or run: export MEMBER_CONVEX_URL=...",
    );
    process.exit(1);
  }
  if (!secret) {
    console.error("Missing MEMBERS_IMPORT_SECRET (must match the Convex deployment env var).");
    console.error(
      'Tip: Name is MEMBERS_IMPORT_SECRET (with an S). Use export MEMBERS_IMPORT_SECRET=... or put it on the same line as npm run.',
    );
    process.exit(1);
  }

  const abs = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(abs)) {
    console.error("File not found:", abs);
    process.exit(1);
  }

  const workbook = XLSX.readFile(abs);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });

  const rows = [];
  for (const raw of rawRows) {
    const itsRaw = cellToString(pickIts(raw));
    const name = pickName(raw);
    const email = pickEmail(raw);
    if (!itsRaw || !name) continue;
    rows.push({
      its_number: itsRaw.replace(/\D/g, ""),
      name,
      email,
    });
  }

  const valid = rows.filter((r) => r.its_number.length > 0);
  if (valid.length === 0) {
    console.error("No valid rows (need itsId + name columns with data).");
    process.exit(1);
  }

  console.log(`Sheet "${sheetName}": ${valid.length} row(s) to upsert.`);

  const client = new ConvexHttpClient(convexUrl);
  let inserted = 0;
  let updated = 0;

  for (let i = 0; i < valid.length; i += BATCH_SIZE) {
    const batch = valid.slice(i, i + BATCH_SIZE);
    const result = await client.mutation(api.members.importMembersBulk, {
      secret,
      rows: batch,
    });
    inserted += result.inserted;
    updated += result.updated;
    console.log(
      `Batch ${Math.floor(i / BATCH_SIZE) + 1}: inserted ${result.inserted}, updated ${result.updated}.`,
    );
  }

  console.log(`Done. Total inserted: ${inserted}, total updated: ${updated}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
