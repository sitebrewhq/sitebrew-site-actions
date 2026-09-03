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
  id-token: write
  pull-requests: write

jobs:
  deploy:
    uses: sitebrewhq/sitebrew-site-actions/.github/workflows/build.yml@<pinned-sha>
```

All three matter even for a push-only caller: `id-token: write` is required
by `deploy` on every run (it mints the OIDC token), and `pull-requests: write`
is required because `deploy` requests it unconditionally for its PR-comment
step — a called job's `permissions:` block can't request more than the
caller grants, regardless of that step's own runtime `if:` condition
(verified live 2026-09-01: omitting either produced a silent `startup_failure`
with no useful log, not a permission-denied error on the specific step).

The caller's own repository must have its **selected actions** allowlist
include this workflow *and* every action it calls internally (`actions/checkout`,
`peaceiris/actions-hugo`, `actions/upload-artifact`, `actions/download-artifact`,
`actions/github-script` — verified live 2026-09-01 that GitHub's allowlist
gates actions used inside a called reusable workflow too, not just the
workflow file itself).

## How it authenticates

1. The `deploy` job requests a GitHub-issued OIDC identity token
   (`id-token: write`), naming the audience `sitebrew-actions-<stage>`.
2. It trades that token for a short-lived R2 upload credential at
   `POST <api-base-url>/v1/actions/upload-token` — `sitebrew-api` verifies the
   token against GitHub's own published keys, matches the calling repository
   against the site registry, and mints a credential scoped to exactly that
   run's R2 prefix (`sites/<siteId>/` for a push to `main`, the sibling
   `sites/pr-<n>--<siteId>/` for a pull-request preview).
3. `scripts/upload-to-r2.mjs` signs each file's `PUT` with that credential
   (hand-rolled AWS SigV4 — no npm dependency; see the script's own module
   doc for why not `aws4fetch` here specifically) and uploads it.

No Cloudflare secret is configured on this repository, the calling site
repository, or any org-wide setting.

## Pull-request previews

A `pull_request` run (`opened`/`synchronize`/`reopened`) builds and deploys
the same way as a push, but to the sibling R2 prefix above, and additionally:

- calls `POST <api-base-url>/v1/actions/deploy-callback` (same OIDC token) to
  record the preview hostname in `sitebrew-worker`'s `HOSTNAMES` KV — the read
  side production skips entirely, since `sitebrew-worker`'s `hostMetadata`
  resolves a production hostname without KV;
- comments the resulting `https://pr-<n>--<siteId>.<preview-domain>/` URL on
  the PR (updates its own prior comment on a later push, matching
  `sitebrew-site-pipeline`'s existing convention).

On `pull_request: closed`, a separate `cleanup` job rebuilds that PR's last
commit (`github.event.pull_request.head.sha`) and deletes the resulting file
list from R2 (`scripts/delete-from-r2.mjs`) — deliberately not a `ListObjectsV2`
call, since a preview's R2 content is always exactly its own last build output
and a list-then-delete flow would need a second, query-string SigV4 signing
path for no gain over rebuilding the same commit. It then calls
`DELETE <api-base-url>/v1/actions/deploy-callback` to remove the KV mapping.

## The `stable` tag and `promote.yml`

Site repos should reference this reusable workflow via
`@refs/tags/stable`, not a literal SHA of their own choosing (`sitebrew-site-bootstrap`'s
template does this for every new fork). `stable` only ever advances after
`.github/workflows/promote.yml` — triggered on every push to this repo's own
`main` — validates that exact commit against a dedicated, permanent,
non-customer site repo, `sitebrewhq/sitebrew-canary-site`: force-push a
standing `canary/promote` branch there whose own `build.yml` is rewritten to
call the candidate commit (GitHub requires a reusable workflow's `uses:` to
be a static string, so this is a real file edit, not a parameterized call),
open a PR against it (which is what actually runs the candidate through the
real `pull_request` job above), poll that exact pushed commit's own
workflow run, and only then force-move `stable`. See
`sitebrewhq/sitebrew-api`'s `design/0006-site-actions-stable-tag.md` for the
full design, including the race a concurrent push could otherwise cause and
how `promote.yml`'s `concurrency` block plus `scripts/wait-for-canary-run.mjs`'s
SHA-scoped poll close it. The poll reads GitHub's Actions API (workflow
runs), not the Checks API, specifically so it needs no App permission beyond
what `sitebrewapp` already has — see that script's own doc.

A broken `promote.yml` fails loudly and leaves `stable` untouched — the
fallback is the same manual repin every site repo used before this
mechanism existed.

## Testing

```
npm test   # node --test scripts/*.test.mjs — no install step, zero deps
```

`scripts/upload-to-r2.test.mjs` and `scripts/delete-from-r2.test.mjs` each
include a frozen-reference-signature test: the hand-rolled SigV4 signer's
output for a fixed request/date is checked against a signature independently
computed with the `aws4` npm package, so a regression fails a test rather
than only failing silently against a live R2 endpoint.
