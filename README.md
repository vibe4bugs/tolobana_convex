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

## Consumer apps

- `tolobana_admin`
- `toloba_na_member_portal`

Both apps depend on this package via:

```json
"@tolobana/convex-backend": "file:../tolobana_convex"
```

and import generated API bindings from:

`@tolobana/convex-backend/convex/_generated/api`
