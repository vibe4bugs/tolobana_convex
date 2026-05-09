# @tolobana/convex-backend

Shared Convex backend for Tolobana admin and member portal.

## Responsibilities

- Own `convex/schema.ts`, all backend function modules, and `auth.config.ts`.
- Be the only place where `npx convex dev` / `npx convex deploy` are run (this repo is still the **single source** for backend code).
- Generate API bindings consumed by both apps.

## Two Convex deployments (admin vs member)

Tolobana intentionally uses **two separate Convex deployments** = **two databases**:

| App | Typical env | Role |
|-----|-------------|------|
| **Admin** (`tolobana_admin`) | `VITE_CONVEX_URL` | Clerk-guarded mutations, surveys, announcements, hub admin, etc. |
| **Member** (`toloba_na_member_portal`) | `VITE_CONVEX_URL_MEMBER` | `members.login`, `members` + `hub_contributions`, reads live content (often from admin deployment — see app wiring). |

This package is **one codebase** pushed to **both** deployments so function names and schema stay in sync. **Each deployment must receive its own `npx convex deploy`** — pushing to admin does **not** update member (and vice versa).

### Deploying to the correct database

Your laptop links `tolobana_convex` to **one** Convex **project** at a time (see `.env.local` / `CONVEX_DEPLOYMENT` from `npx convex dev`).

1. **Admin prod** (e.g. `fortunate-ox-402`): link CLI to the **admin** Convex project → from `tolobana_convex` run `npx convex deploy` and confirm when prompted (production for that project).

2. **Member prod** (e.g. `mild-hedgehog-2`): switch this folder to the **member** Convex **project** (separate from admin — separate DB), then deploy again. Typical approaches:
   - Run `npx convex dev` and go through project setup **selecting the member project** when prompted (if your `.env.local` is cleared or you’re linking for the first time), **or**
   - In the [Convex dashboard](https://dashboard.convex.dev), open the **member** project (the one that lists deployment `mild-hedgehog-2` / your member URL), open **Settings → Deploy / CLI**, and follow the instructions to **deploy this backend** to that project.

After the CLI is tied to the **member** project, `npx convex deploy` updates **member** prod. Passing `--url` on deploy does **not** reliably switch projects — the linked project in `.env.local` / Convex config decides where code goes.

Same repo, **two pushes** when you release: once linked to **admin** → deploy; once linked to **member** → deploy.

Set **`MEMBERS_IMPORT_SECRET`** only on the **member** deployment in the dashboard; run XLSX import with `MEMBER_CONVEX_URL` = that member URL.

## Usage

From this directory:

```bash
nvm use
npm install
npx convex dev
```

For production releases (repeat per linked project when maintaining **two** deployments — see above):

```bash
npx convex deploy
```

## Member roster import (XLSX → `members` table)

Login in the member portal is an ITS lookup against the **`members`** table on whichever Convex deployment your app uses as **`VITE_CONVEX_URL_MEMBER`**. Import the spreadsheet into **that same deployment** so sign-in resolves real rows.

1. In the Convex dashboard for the **member** deployment (same URL as `VITE_CONVEX_URL_MEMBER` / `MEMBER_CONVEX_URL`), add an environment variable:
   - **`MEMBERS_IMPORT_SECRET`** — a long random string (keep it private).

2. **Deploy this backend to the member Convex project** so `members.importMembersBulk` exists on **member** prod. Link your CLI to the **member** project (see [Two Convex deployments](#two-convex-deployments-admin-vs-member)), then run `npx convex deploy`. `npx convex dev` only syncs the **linked dev** deployment.

   If the import fails with **Could not find public function for `members:importMembersBulk`**, member prod does not have this code yet — deploy from `tolobana_convex` while linked to the **member** project, then retry the import.

3. From this repo (after `npm install`).

**Use one line** (recommended — variables are passed to `npm`/`node` automatically):

```bash
MEMBER_CONVEX_URL="https://YOUR_MEMBER_DEPLOYMENT.convex.cloud" \
MEMBERS_IMPORT_SECRET="same-as-dashboard" \
npm run import-members -- /absolute/or/relative/path/to/members.xlsx
```

If you set variables on **separate lines** first, you must **`export`** them or `npm run` will not see them:

```bash
export MEMBER_CONVEX_URL="https://YOUR_MEMBER_DEPLOYMENT.convex.cloud"
export MEMBERS_IMPORT_SECRET="same-as-dashboard"
npm run import-members -- /path/to/members.xlsx
```

Note the secret name is **`MEMBERS_IMPORT_SECRET`** (not `MEMBER_IMPORT_SECRET`).

(`CONVEX_URL` is still accepted by the script for backward compatibility.)

If you see `XLSX.readFile is not a function`, pull the latest `tolobana_convex` — the import script uses the SheetJS default export so it works with Node’s ESM ↔ CommonJS interop.

4. Spreadsheet: first sheet should have a header row. Supported column names (case-insensitive):
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
