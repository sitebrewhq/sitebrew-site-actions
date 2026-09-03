#!/usr/bin/env node
/**
 * Poll `sitebrew-api`'s `/v1/actions/canary-status` for the *exact* commit
 * `promote-canary-trigger.mjs` just pushed to `canary/promote` — never the
 * pull request's "current"/"latest" state (DevGuru, 2026-09-03 review of
 * design/0006: the same SHA-scoped-not-PR-scoped fix as before).
 * `promote.yml`'s `concurrency: cancel-in-progress: false` is the other half
 * of that fix.
 *
 * Reads through `sitebrew-api` rather than calling GitHub's Actions API
 * directly (this file's previous shape) — found, 2026-09-03, getting the
 * first fully automatic promotion working: an executor-minted token
 * (`/canary-token`) can never carry `actions: read`. It is on
 * `FORBIDDEN_EXECUTOR_PERMISSIONS` (`sitebrew-api`), the same guard that
 * already forbids `workflows` — confirmed live, a real promotion 403'd
 * calling GitHub directly with a `/canary-token`-minted credential.
 * `/v1/actions/canary-status` does that GitHub call itself, server-side, on
 * the app's own shared installation credential; this script never holds
 * anything broader than the OIDC identity `/canary-token` already verifies.
 *
 * A fresh OIDC token is minted for **every** poll attempt, not once for the
 * whole ~5-minute cycle (DevGuru, 2026-09-03) — there is no long-lived
 * credential here to reuse the way the old design reused its
 * `/canary-token`-minted installation token across the whole loop.
 *
 * Returns a plain `"timeout"` value rather than throwing when the status
 * never reaches a terminal state — `promote.yml`'s own next step branches
 * on `success` vs. anything else and fails loudly either way (`failure` and
 * `timeout` both mean `stable` must not move); only a genuine transport/API
 * error (a non-2xx response) throws, since that is not a verdict about the
 * candidate at all.
 */

const DEFAULT_INTERVAL_MS = 15000;
// ~5 minutes at the default interval — a Hugo build + one-file R2 upload is
// fast (design/0006, "Promotion" step 3's "sane timeout"); a real hang here
// should fail the promotion, not the whole Actions job's own runner timeout.
const DEFAULT_MAX_ATTEMPTS = 20;

/**
 * Trades this run's own GitHub OIDC identity for a fresh token, the same
 * bearer-token dance `build.yml`'s "Request GitHub OIDC token" step does in
 * bash — done here in JS instead, since it now has to run once per poll
 * attempt rather than once per job. `ACTIONS_ID_TOKEN_REQUEST_URL`/`_TOKEN`
 * are the runner's own env vars (present on any step in a job with
 * `id-token: write`), not something this script or `promote.yml` sets.
 */
async function mintOidcToken(audience, fetchImpl = fetch) {
  const url = `${process.env.ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${encodeURIComponent(audience)}`;
  const response = await fetchImpl(url, {
    headers: { authorization: `bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
  });
  if (!response.ok) {
    throw new Error(`OIDC token request answered ${response.status}`);
  }
  const body = await response.json();
  return body.value;
}

/**
 * `mintToken`/`fetchImpl`/`sleepImpl` are injectable the same way
 * `upload-to-r2.mjs`'s `uploadDirectoryToR2` injects `fetchImpl` — the true
 * I/O boundaries a test should mock, not this function's own control flow.
 */
export async function waitForCandidateStatus({
  apiBaseUrl,
  audience,
  sha,
  fetchImpl = fetch,
  mintToken = mintOidcToken,
  intervalMs = DEFAULT_INTERVAL_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const token = await mintToken(audience, fetchImpl);
    const response = await fetchImpl(`${apiBaseUrl}/v1/actions/canary-status`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ sha }),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`canary-status lookup for ${sha} answered ${response.status}: ${detail.slice(0, 300)}`);
    }
    const { conclusion } = await response.json();
    if (conclusion !== "pending") return conclusion;
    if (attempt < maxAttempts - 1) await sleepImpl(intervalMs);
  }
  return "timeout";
}

async function main() {
  const { API_BASE_URL, OIDC_AUDIENCE, CANDIDATE_SHA, POLL_INTERVAL_MS, POLL_MAX_ATTEMPTS } = process.env;
  if (!API_BASE_URL) throw new Error("missing required env var API_BASE_URL");
  if (!OIDC_AUDIENCE) throw new Error("missing required env var OIDC_AUDIENCE");
  if (!CANDIDATE_SHA) throw new Error("missing required env var CANDIDATE_SHA");

  const conclusion = await waitForCandidateStatus({
    apiBaseUrl: API_BASE_URL,
    audience: OIDC_AUDIENCE,
    sha: CANDIDATE_SHA,
    ...(POLL_INTERVAL_MS ? { intervalMs: Number(POLL_INTERVAL_MS) } : {}),
    ...(POLL_MAX_ATTEMPTS ? { maxAttempts: Number(POLL_MAX_ATTEMPTS) } : {}),
  });

  const out = process.env.GITHUB_OUTPUT;
  if (out) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(out, `conclusion=${conclusion}\n`);
  }
  console.log(`canary-status for ${CANDIDATE_SHA}: ${conclusion}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.stack ?? String(err));
    process.exit(1);
  });
}
