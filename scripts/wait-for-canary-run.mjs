#!/usr/bin/env node
/**
 * Poll `sitebrew-canary-site`'s own workflow runs for the *exact* commit
 * `promote-canary-branch.mjs` just force-pushed to `canary/promote` — never
 * the pull request's "current"/"latest" state (DevGuru, 2026-09-03 review of
 * design/0006: the same SHA-scoped-not-PR-scoped fix as before).
 * `promote.yml`'s `concurrency: cancel-in-progress: false` is the other half
 * of that fix — it queues overlapping runs so they don't interleave on the
 * branch this file's `sha` parameter names; this file is what stops a run
 * from being fooled even if they did.
 *
 * Reads GitHub's Actions API (`GET .../actions/runs?head_sha=`) rather than
 * the Checks API (`GET .../commits/{sha}/check-runs`, this file's original
 * shape) — found, 2026-09-03, while getting the first live promotion
 * working: the Checks API needs a `checks: read` GitHub App permission
 * `sitebrewapp` does not hold, and granting it needs an org admin. The
 * Actions API's read endpoints are covered by the `actions: write`
 * permission the app already has (write is a documented superset of read),
 * so this switch needs no new grant at all. Side benefit, not the reason for
 * the switch: a workflow run's own `conclusion` already aggregates every job
 * inside it, so there is no equivalent of the Checks API's
 * unrelated-third-party-check noise to filter out here (`evaluateCheckRuns`'s
 * former `[code]smith`-shows-up-as-`skipped` problem) — a run this call
 * returns is always one this repository's own workflow triggered.
 *
 * Returns a plain `"timeout"` value rather than throwing when the run never
 * reaches a terminal state — `promote.yml`'s own next step branches on
 * `success` vs. anything else and fails loudly either way (`failure` and
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
 * Decide whether a `head_sha`-filtered `actions/runs` response is a terminal
 * answer yet. Exported separately from `waitForCandidateRun` so a test can
 * exercise every response shape (nothing started, still running, mixed, all
 * terminal) without driving the loop's own timing or a real `fetch`.
 */
export function evaluateWorkflowRuns(runs) {
  if (runs.length === 0) return { done: false };
  const pending = runs.filter((run) => run.status !== "completed");
  if (pending.length > 0) return { done: false };
  const failed = runs.filter((run) => run.conclusion !== "success");
  return { done: true, conclusion: failed.length === 0 ? "success" : "failure" };
}

/**
 * `GET /repos/{repo}/actions/runs?head_sha={sha}`, polled until every
 * workflow run for `sha` is `completed`. `fetchImpl`/`sleepImpl` are
 * injectable the same way `upload-to-r2.mjs`'s `uploadDirectoryToR2` injects
 * `fetchImpl` — the true I/O boundary a test should mock, not this
 * function's own control flow.
 */
export async function waitForCandidateRun({
  repo,
  sha,
  token,
  fetchImpl = fetch,
  intervalMs = DEFAULT_INTERVAL_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await fetchImpl(`https://api.github.com/repos/${repo}/actions/runs?head_sha=${sha}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
      },
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`actions/runs lookup for ${sha} answered ${response.status}: ${detail.slice(0, 300)}`);
    }
    const { workflow_runs: runs } = await response.json();
    const result = evaluateWorkflowRuns(runs);
    if (result.done) return result.conclusion;
    if (attempt < maxAttempts - 1) await sleepImpl(intervalMs);
  }
  return "timeout";
}

async function main() {
  const { CANARY_REPO, CANDIDATE_SHA, GH_TOKEN, POLL_INTERVAL_MS, POLL_MAX_ATTEMPTS } = process.env;
  if (!CANARY_REPO) throw new Error("missing required env var CANARY_REPO");
  if (!CANDIDATE_SHA) throw new Error("missing required env var CANDIDATE_SHA");
  if (!GH_TOKEN) throw new Error("missing required env var GH_TOKEN");

  const conclusion = await waitForCandidateRun({
    repo: CANARY_REPO,
    sha: CANDIDATE_SHA,
    token: GH_TOKEN,
    ...(POLL_INTERVAL_MS ? { intervalMs: Number(POLL_INTERVAL_MS) } : {}),
    ...(POLL_MAX_ATTEMPTS ? { maxAttempts: Number(POLL_MAX_ATTEMPTS) } : {}),
  });

  const out = process.env.GITHUB_OUTPUT;
  if (out) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(out, `conclusion=${conclusion}\n`);
  }
  console.log(`workflow runs for ${CANDIDATE_SHA} on ${CANARY_REPO}: ${conclusion}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.stack ?? String(err));
    process.exit(1);
  });
}
