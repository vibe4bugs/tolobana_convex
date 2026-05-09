# @tolobana/convex-backend

Shared Convex backend for Tolobana admin and member portal.

## Responsibilities

- Own `convex/schema.ts`, all backend function modules, and `auth.config.ts`.
- Be the only place where `npx convex dev` / `npx convex deploy` are run for the shared deployment.
- Generate API bindings consumed by both apps.

## Usage

From this directory:

```bash
nvm use
npm install
npx convex dev
```

For production releases:

```bash
npx convex deploy
```

## Member roster import (XLSX → `members` table)

Login in the member portal is an ITS lookup against the **`members`** table on whichever Convex deployment your app uses as **`VITE_CONVEX_URL_MEMBER`**. Import the spreadsheet into **that same deployment** so sign-in resolves real rows.

1. In the Convex dashboard for the **member** deployment, add an environment variable:
   - **`MEMBERS_IMPORT_SECRET`** — a long random string (keep it private).

2. From this repo (after `npm install`):

```bash
MEMBER_CONVEX_URL="https://YOUR_MEMBER_DEPLOYMENT.convex.cloud" \
MEMBERS_IMPORT_SECRET="same-as-dashboard" \
npm run import-members -- /absolute/or/relative/path/to/members.xlsx
```

(`CONVEX_URL` is still accepted by the script for backward compatibility.)

3. Spreadsheet: first sheet should have a header row. Supported column names (case-insensitive):
   - **`itsId`** (or `its_number`, `ITS`, etc.) — required; stored as digits-only for lookup.
   - **`name`** (or `full name`) — required.
   - **`email`** — optional.

Format the ITS column as **Text** in Excel if IDs are long (avoids rounding).

The dev helper mutation `seed` still inserts sample members (`12345678`, …) — do not run it in production, or delete those rows after importing your roster.

## Consumer apps

- `tolobana_admin`
- `toloba_na_member_portal`

Both apps depend on this package via:

```json
"@tolobana/convex-backend": "github:vibe4bugs/tolobana_convex#main"
```

(Use a tag or commit SHA instead of `#main` for reproducible releases.)

and import generated API bindings from:

`@tolobana/convex-backend/convex/_generated/api`
