# Space Cubics Cloudflare deployment

asciiweave has two server targets built from the same application code:

| Target              | Runtime         | Database           | Entry point                  |
| ------------------- | --------------- | ------------------ | ---------------------------- |
| Local / on-premises | Node.js >= 26   | `node:sqlite` file | `server/src/index.ts`        |
| Cloudflare          | Workers runtime | D1 (binding `DB`)  | `server/src/worker/index.ts` |

This is the runbook for deploying asciiweave in the Space Cubics Cloudflare
account. Its resource names, database IDs, domain, access policy, GitHub
environments, and secrets are specific to that deployment. The local target is
included where shared migrations or runtime differences affect the runbook.

The browser never touches SQLite or D1; it talks only to the HTTP API
and the `/collab/<id>` WebSocket. On Cloudflare, each document's
WebSocket room is a `CollabRoom` Durable Object (the single writer for
that document), and static assets are served by Workers Assets with SPA
fallback. See [`architecture.md`](architecture.md) for the design.

## Adapting the Cloudflare target

An operator deploying asciiweave to another Cloudflare account must adapt the
repository configuration before using this runbook:

1. Create separate D1 databases for each desired environment.
2. Replace the Worker names, D1 names and IDs, and environment entries in
   `wrangler.jsonc`.
3. Configure a `workers.dev` hostname or replace the custom-domain route with a
   domain in the operator's account.
4. Configure deployment credentials for that account and an independent
   access-control policy for the application.
5. Apply the shared migrations and deploy with an explicit `--env` value.

Do not deploy the checked-in staging or production environments unchanged from
another account. The remainder of this document describes the Space Cubics
resources and policy.

## Cloudflare resources

Everything lives in the corporate Cloudflare account
(cloudflare@spacecubics.com):

| Purpose    | Worker               | D1 database             | URL                                  |
| ---------- | -------------------- | ----------------------- | ------------------------------------ |
| Staging    | `asciiweave-staging` | `asciiweave-staging`    | workers.dev subdomain                |
| Production | `asciiweave`         | `asciiweave-production` | <https://asciiweave.spacecubics.org> |

The production URL is a Worker Custom Domain declared in
`wrangler.jsonc` (`routes` with `custom_domain: true`); Cloudflare
creates and maintains the DNS record and certificate for it on deploy.
The API token used for deployment therefore needs Workers Routes:Edit
scoped to the `spacecubics.org` zone in addition to the account-level
Workers and D1 scopes; without it the deploy fails with authentication
error 10000 on `/zones/<id>/workers/routes` after the Worker itself has
already uploaded. No DNS permission is needed; the Workers platform
manages the record itself.

`wrangler.jsonc` defines both as environments; the top-level config
(`asciiweave-dev`) exists only for local development and the workerd
test pool, so a bare `wrangler deploy` cannot touch a real target —
always pass `--env staging` or `--env production`.

## Deployment credentials and application access

asciiweave itself does not authenticate users or authorize document access.
Cloudflare Access protects <https://asciiweave.spacecubics.org> with an
employee-only policy. The Access service token below is only for the automated
health check; it is not application authentication.

- **Local CLI**: `npx wrangler login` (OAuth, browser flow). Check with
  `npx wrangler whoami` — it must show the corporate account. Never use
  a Global API Key.
- **GitHub CI**: repository secrets `CLOUDFLARE_API_TOKEN` (an
  account-owned API token, `github-asciiweave`, with Workers
  Scripts:Edit + D1:Edit on this account plus Workers Routes:Edit on
  the `spacecubics.org` zone) and `CLOUDFLARE_ACCOUNT_ID`. Create or
  edit the token in the Cloudflare dashboard (Manage Account -> Account
  API Tokens; editing its permissions does not rotate the secret), then
  store both with Settings -> Secrets and variables -> Actions, or
  `gh secret set CLOUDFLARE_API_TOKEN` fed from a secure source.
  Secrets are never exposed to pull requests from forks.

  The production smoke test also requires `CLOUDFLARE_ACCESS_CLIENT_ID`
  and `CLOUDFLARE_ACCESS_CLIENT_SECRET`, the credentials of an Access
  service token (Zero Trust -> Access controls -> Service credentials).
  The Access application covering `asciiweave.spacecubics.org` must
  have a policy with action **Service Auth** that includes that service
  token; a regular Allow policy never matches a service token, because
  Allow requires an interactive identity. The symptom of a missing or
  wrong Service Auth policy is a 302 redirect to the Access login page,
  which `curl -f` does not treat as an error.

## Schema migrations

One numbered, immutable SQL series in `migrations/` serves both
databases. Once a file has been applied to staging or production, never
edit it — add a new numbered file.

- Local SQLite: applied automatically at server startup, or by hand:
  `npm run db:status` / `npm run db:migrate` (path from
  `ASCIIWEAVE_DB`). Tracking uses the same `d1_migrations` table
  Wrangler uses.
- D1: `npx wrangler d1 migrations apply DB --remote --env staging`
  (or `--env production`). Local simulator: drop `--remote`.

Keep migrations inside the SQLite subset D1 supports: no PRAGMAs, no
extensions. Connection setup such as WAL mode lives in
`server/src/persistence/sqlite.ts`, not in migrations.

## Branch -> staging -> production flow

1. **Pull requests / branches**: GitHub Actions runs lint, format,
   typecheck, unit tests, D1 contract tests (locally in workerd — no
   credentials), the production build, and the Playwright suite.
2. **Staging**: deploy manually — either the _Deploy staging_ workflow
   (`workflow_dispatch`, same-repository branches only) or locally:

   ```sh
   npm run build
   npx wrangler d1 migrations apply DB --remote --env staging
   npx wrangler deploy --env staging --var GIT_COMMIT:$(git rev-parse HEAD)
   ```

   (`npm run deploy:staging` bundles the same steps.) Verify
   `<staging-url>/api/health` reports `{"ok":true,"commit":<sha>}`.
   Do not drop or reset the staging database as part of routine tests.

3. **Production**: the normal path is to rebase-merge a reviewed pull request.
   Repository policy prevents direct pushes to `main`, allows only rebase
   merges, and requires linear history. The _Deploy production_ workflow runs
   after a `push` to `main` and can also be started manually for a selected ref
   with `workflow_dispatch`. In either case, it runs its configured validation
   and build steps before applying pending migrations and deploying the
   `asciiweave` Worker, then smoke-tests `/api/health` through Cloudflare
   Access. A `pull_request` event does not trigger a production deployment. The
   [`deploy-production.yml`](../.github/workflows/deploy-production.yml)
   workflow is the authoritative definition of its triggers and target.

Both deployment callers retain their own concurrency group and restrict runs
to `spacecubics/asciiweave`. They call
[`deploy.yml`](../.github/workflows/deploy.yml), which defines the shared
validation, build, migration, deployment, and health-check steps. Migrations
run in Wrangler's `preCommands`, so a migration failure prevents deployment.
Staging checks Wrangler's deployment URL without Access headers; production
checks its canonical URL with the Access service token.

The health check retries up to ten times, waiting three seconds between
attempts, until the response reports `ok: true` and the exact deployed commit.
A healthy response from the previous Worker version is retried while the
deployment propagates. Requests have a five-second connection timeout and a
ten-second total timeout. Exhausting the attempts fails the workflow even if
the Worker upload succeeded; inspect the deployment and health-check logs
before deciding whether to redeploy.

The reusable workflow has separate, mutually exclusive staging and production
jobs sharing one YAML-anchored step list. Staging remains outside any GitHub
environment. The production runner job binds the `production` environment,
preserving its protection rules and secret scope. Callers pass named secrets
explicitly; same-named production environment secrets take precedence over
the passed repository secrets. Access credentials are optional in the shared
interface because staging does not use them, but remain required for the
production health check.

Because the Worker implements a Durable Object, Cloudflare does not
generate preview URLs for uploaded versions — use the dedicated staging
Worker for integration testing.

## Rollback

- **Worker code**: before rolling back, confirm that the selected Worker
  version is compatible with the current production schema. Use
  `npx wrangler rollback --env production` or the dashboard's Deployments
  page. Rolling back code does **not** roll back the schema.
- **Schema**: prefer expand-and-contract — additive migration first,
  deploy code tolerating old and new schema, destructive cleanup only
  in a later migration once no deployed code needs the old shape. Never
  run a "down" migration automatically as part of a code rollback.
- **Data**: D1 Time Travel can restore the database to a point in the
  last 30 days (`wrangler d1 time-travel info asciiweave-production`);
  confirm retention on the account's plan before relying on it.

## Known differences: local SQLite vs D1

- `node:sqlite` is synchronous under an async interface; D1 is remote
  and asynchronous. Both sit behind `DocumentStore`
  (`server/src/persistence/store.ts`) and pass the same contract suite
  (`server/tests/store-contract.ts`).
- BLOBs: D1 returns `ArrayBuffer` and takes `ArrayBuffer` parameters;
  the D1 store converts to/from `Uint8Array` at the boundary.
- WAL mode and other PRAGMAs exist only on the Node target.
- The Node target keeps live rooms in process memory (y-websocket); the
  Worker keeps them in per-document Durable Objects. On both, the
  durable Yjs state is persisted debounced (~1 s), plus a flush when
  the last client leaves.
- The Durable Object does not ping idle WebSocket clients; dead
  connections are reaped by the runtime rather than by heartbeat.
