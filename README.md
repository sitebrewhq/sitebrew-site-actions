# sitebrew-site-actions

Reusable GitHub Actions workflow that builds a Hugo site and publishes it to
Cloudflare R2 without ever holding a Cloudflare credential in the calling
repository. Part of ADR-0003 (`sitebrew-docs`, `adr/0003`) / design/0005 §8's
Actions-publish model.

## Usage

From a site repository's own `.github/workflows/build.yml`:

```yaml
name: build-and-deploy
on:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  deploy:
    uses: sitebrewhq/sitebrew-site-actions/.github/workflows/build.yml@<pinned-sha>
```

The caller's own repository must have its **selected actions** allowlist
include this workflow *and* every action it calls internally (`actions/checkout`,
`peaceiris/actions-hugo`, `actions/upload-artifact`, `actions/download-artifact`
— verified live 2026-09-01 that GitHub's allowlist gates actions used inside a
called reusable workflow too, not just the workflow file itself).

## How it authenticates

1. The `deploy` job requests a GitHub-issued OIDC identity token
   (`id-token: write`), naming the audience `sitebrew-actions-<stage>`.
2. It trades that token for a short-lived R2 upload credential at
   `POST <api-base-url>/v1/actions/upload-token` — `sitebrew-api` verifies the
   token against GitHub's own published keys, matches the calling repository
   against the site registry, and mints a credential scoped to exactly that
   site's R2 prefix (`sites/<siteId>/`).
3. `scripts/upload-to-r2.mjs` signs each file's `PUT` with that credential
   (hand-rolled AWS SigV4 — no npm dependency; see the script's own module
   doc for why not `aws4fetch` here specifically) and uploads it.

No Cloudflare secret is configured on this repository, the calling site
repository, or any org-wide setting.

## Scope of this version

Push to `main` only. PR-preview builds and the `deploy-callback` hostname
mapping they need are a deliberate, separate follow-up (thread
`1788253815.206359`, 2026-09-01) — `sitebrew-api`'s `/v1/actions/deploy-callback`
endpoint already exists for this, just not called from here yet.

## Testing

```
npm test   # node --test scripts/*.test.mjs — no install step, zero deps
```

`scripts/upload-to-r2.test.mjs` includes a frozen-reference-signature test:
the `signPutRequest` output for a fixed request/date is checked against a
signature independently computed with the `aws4` npm package, so a
regression in the hand-rolled signer fails a test rather than only failing
silently against a live R2 endpoint.
