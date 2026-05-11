# @tolobana/convex-backend

Shared Convex backend for Tolobana admin and member portal.

## Responsibilities

- Own `convex/schema.ts`, all backend function modules, and `auth.config.ts`.
- Be the only place where `npx convex dev` / `npx convex deploy` are run (this repo is still the **single source** for backend code).
- Generate API bindings consumed by both apps.

## Required Convex dashboard variables

`convex/auth.config.ts` uses **`CLERK_JWT_ISSUER_DOMAIN`**. Convex blocks **`convex dev`** / **`convex deploy`** until that variable exists **on the deployment** (Dashboard → **Settings** → **Environment variables**), not only in a local `.env` file.

Use the **Issuer** from Clerk → **JWT Templates** → the template configured for Convex (typically `https://<your-subdomain>.clerk.accounts.dev`). Set it on **every** deployment you sync to (development and production each have their own env).

**Member portal does not use Clerk in the UI** (ITS login), but this repo still ships **`auth.config.ts`** for the shared Convex backend. Convex requires **`CLERK_JWT_ISSUER_DOMAIN`** on any deployment that bundle references — including member-only URLs — so pushes succeed and admin-style functions (`requireIdentity`) keep working when the **admin** app hits the same backend. Setting the variable does **not** force member users through Clerk.

If the CLI fails with “used in auth config file but its value was not set”, open the URL it prints (or **Dashboard → your deployment → Environment variables**) and add **`CLERK_JWT_ISSUER_DOMAIN`**.

## Two Convex deployments (admin vs member)

Tolobana intentionally uses **two separate Convex deployments** = **two databases**:

| App | Typical env | Role |
|-----|-------------|------|
| **Admin** (`tolobana_admin`) | `VITE_CONVEX_URL` | Clerk-guarded mutations, surveys, announcements, hub admin, etc. |
| **Member** (`toloba_na_member_portal`) | `VITE_CONVEX_URL_MEMBER` | `members.login`, `members` + `hub_contributions`, reads live content (often from admin deployment — see app wiring). |

This package is **one codebase** pushed to **both** deployments so function names and schema stay in sync. **Each deployment must receive its own `npx convex deploy`** — pushing to admin does **not** update member (and vice versa).

### Development vs production (within one Convex project)

Every Convex **project** has a **development** deployment and a **production** deployment. They are different URLs and different data.

| Tier | What you might see (example) | How to push backend code there |
|------|------------------------------|--------------------------------|
| **Development** | `https://mild-hedgehog-2.convex.cloud` | `npx convex dev --once --env-file .env.member.local` (or ongoing `npx convex dev` with `CONVEX_DEPLOYMENT=dev:…` matching that deployment) |
| **Production** | `https://fortunate-ox-402.convex.cloud` | `npx convex deploy --env-file .env.member.local` — when prompted, confirm push to **prod** |

**`npx convex deploy` always targets production** for the project implied by `CONVEX_DEPLOYMENT` / your CLI link. It does **not** update the dev deployment. If you answered **No** at the prod prompt, nothing was pushed to prod; your dev deployment is unchanged unless you run **`convex dev`** (or `--once`).

Match **`VITE_CONVEX_URL_MEMBER`** to the tier you intend: use the **dev** host if you only want test data; use the **prod** host for real members. Import XLSX and set **`MEMBERS_IMPORT_SECRET`** on the **same** host your app calls.

### Deploying to the correct database

Your laptop links `tolobana_convex` to **one** Convex **project** at a time (see `.env.local` / `CONVEX_DEPLOYMENT` from `npx convex dev`).

1. **Admin prod** (e.g. `fortunate-ox-402`): link CLI to the **admin** Convex project → from `tolobana_convex` run `npx convex deploy` and confirm when prompted (production for that project).

2. **Member prod** (separate Convex **project** from admin — separate DB): switch this folder to the **member** Convex **project**, then deploy to **that** project’s production URL. Typical approaches:
   - Run `npx convex dev` and go through project setup **selecting the member project** when prompted (if your `.env.local` is cleared or you’re linking for the first time), **or**
   - In the [Convex dashboard](https://dashboard.convex.dev), open the **member** project (the one that lists deployment `mild-hedgehog-2` / your member URL), open **Settings → Deploy / CLI**, and follow the instructions to **deploy this backend** to that project.

After the CLI is tied to the **member** project, `npx convex deploy` updates **member** prod. Passing `--url` on deploy does **not** reliably switch projects — the linked project in `.env.local` / Convex config decides where code goes.

Same repo, **two pushes** when you release: once linked to **admin** → deploy; once linked to **member** → deploy.

Set **`MEMBERS_IMPORT_SECRET`** only on the **member** deployment in the dashboard; run XLSX import with `MEMBER_CONVEX_URL` = that member URL.

### How to point this folder at the member project (or admin)

Convex decides which deployment you hit from **project link data** (usually in `.env.local`), not from `VITE_*` in the React apps.

**Recommended: two env files + `--env-file`**

1. Leave your normal **admin** link in `.env.local` (what you already use with `npx convex dev`).
2. In [Convex Dashboard](https://dashboard.convex.dev), open the **member** project — the one whose **production** URL matches `VITE_CONVEX_URL_MEMBER` (e.g. `https://mild-hedgehog-2.convex.cloud`).
3. Open **Project settings** → **CLI** / **Deploy** (wording varies) and copy the **environment / CLI variables** Convex shows for that project (often includes `CONVEX_DEPLOYMENT` and related values).
4. Create **`tolobana_convex/.env.member.local`** (gitignored) **before** running deploy — the file must exist on disk. Start from the committed template **`/.env.member.local.example`** (`cp .env.member.local.example .env.member.local`) and paste the Convex CLI variables from the dashboard (for example `CONVEX_DEPLOYMENT` and/or `CONVEX_DEPLOY_KEY`, depending on what your project shows). Do not commit `.env.member.local`.

   If you run deploy **before** creating the file, Node.js may print **`node: .env.member.local: not found`** — that means the path is missing or wrong.

5. Push code to the **member** deployment your app uses:

   **Production member URL** (dashboard prod host, e.g. `fortunate-ox-402`):

   ```bash
   cd tolobana_convex
   npx convex deploy --env-file .env.member.local
   ```

   Confirm when asked — this updates **prod**, not dev.

   **Development member URL** (e.g. `mild-hedgehog-2`): use dev sync instead of deploy:

   ```bash
   npx convex dev --once --env-file .env.member.local
   ```

   The CLI flag `--env-file` overrides `.env.local` for that command so you do not have to swap files by hand.

   **Alternative (no file):** pass the same variables inline for one command, for example:

   ```bash
   CONVEX_DEPLOYMENT="…from dashboard…" npx convex deploy
   ```

   (Exact variable names match what the Convex dashboard shows for that project.)

**Alternate: re-link the folder (swap projects)**

1. Copy `.env.local` to a backup (e.g. `.env.local.admin.bak`).
2. Delete or rename `.env.local`, then run `npx convex dev` and complete setup, choosing the **member** project.
3. Run `npx convex deploy` — that push goes to **member** prod.
4. Restore your admin `.env.local` from the backup when you need to work on admin again.

**Verify:** After a member deploy, the dashboard for the **member** project should show a new deployment / recent push; the **admin** project is unchanged.

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

2. **Push this backend** to the **same Convex deployment** your `MEMBER_CONVEX_URL` / `VITE_CONVEX_URL_MEMBER` uses (see [Development vs production](#development-vs-production-within-one-convex-project)): **`npx convex deploy`** for production, or **`npx convex dev --once`** for development.

   If the import fails with **Could not find public function for `members:importMembersBulk`**, that deployment does not have this code yet — push from `tolobana_convex` with the correct `--env-file` / project link, then retry the import.

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

### Admin survey responses (`its_id` / `name` columns)

The admin **Responses** table loads `api.surveys.listSubmissionsForSurvey`, which joins **`members` on the same Convex deployment** as surveys (`VITE_CONVEX_URL` in **tolobana_admin**).

#### Option A — Roster bridge (recommended when roster lives on member only)

The admin UI calls **`surveyRosterBridge.fetchMemberRosterByEmails`** (Clerk-signed **action** on the **surveys** deployment). It queries the **member** deployment over HTTP using a shared secret.

1. Generate a long random string **`MEMBER_ROSTER_BRIDGE_SECRET`**.
2. In the Convex dashboard for the **member** deployment (e.g. `https://mild-hedgehog-2.convex.cloud`), add **`MEMBER_ROSTER_BRIDGE_SECRET`** with that value.
3. In the dashboard for the **surveys/admin** deployment (`VITE_CONVEX_URL`), add:
   - **`MEMBER_ROSTER_BRIDGE_SECRET`** — same string as on member.
   - **`MEMBER_ROSTER_CONVEX_URL`** — member base URL, e.g. `https://mild-hedgehog-2.convex.cloud` (no trailing slash).

Redeploy **both** deployments from `tolobana_convex` after pulling this code. The admin Responses tab merges local `members` (if any) with the remote map from member.

#### Option B — Duplicate roster on the surveys deployment

If you prefer not to use the bridge, import the same XLSX into the **surveys** deployment as well (see [Member roster import](#member-roster-import-xlsx--members-table) with `MEMBER_CONVEX_URL` set to that deployment’s URL).

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
