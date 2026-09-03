#!/usr/bin/env node
/**
 * Force `sitebrew-canary-site`'s standing `canary/promote` branch to call
 * this exact candidate commit of `sitebrew-site-actions`'s reusable
 * `build.yml` — design/0006's promotion mechanism. GitHub requires a
 * reusable workflow's `uses:` to be a static string (no dispatch input, no
 * expression), so testing one candidate commit before it becomes `@stable`
 * means editing a real file and running the real `pull_request` pipeline
 * that edit triggers, not parameterizing a call.
 *
 * `dir` is expected to already be a checkout of the canary repo's `main`
 * (this run's own `actions/checkout` step, authenticated with a GitHub App
 * installation token scoped to exactly that repository — `/v1/actions/
 * canary-token`, sitebrew-api#131 — so the `push` below can write). Every
 * run starts from `main`, never from a previous run's `canary/promote`
 * state: canary's `main` always calls `@stable`, and `canary/promote` is
 * the only place a literal candidate SHA is ever written and it is
 * overwritten every promotion (design/0006, *Design*) — carrying forward a
 * stale local branch would defeat that.
 *
 * Kept dependency-free like `upload-to-r2.mjs`: this shells out to the
 * `git` binary the Actions runner already provides rather than reaching for
 * an npm git library, for the same reason that script hand-rolls SigV4 —
 * one more package is one more supply-chain surface for a script a
 * customer-triggered event (a push to this repo's own `main`) causes to run
 * with a real write credential.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SITE_ACTIONS_REPO = "sitebrewhq/sitebrew-site-actions";
const WORKFLOW_PATH = ".github/workflows/build.yml";

function usesLinePattern() {
  const escapedRepo = SITE_ACTIONS_REPO.replace(/\//g, "\\/");
  return new RegExp(`^(\\s*uses:\\s*${escapedRepo}\\/\\.github\\/workflows\\/build\\.yml)@\\S+(.*)$`, "m");
}

/**
 * Rewrite the line in a `build.yml` content string that calls this
 * repository's own reusable workflow so its `@<ref>` names `sha` instead —
 * pure string transform, no filesystem or git access, so every shape
 * (existing SHA pin, existing `@stable`, a trailing version comment) is a
 * plain unit test rather than something needing a real checkout.
 *
 * Throws instead of returning the input unchanged when the line is
 * missing: `pointCanaryAtCandidate` below treats no diff as "already
 * promoted, nothing to test" (see its own doc) — a canary `build.yml` that
 * has drifted to not calling this workflow at all must fail loudly here,
 * not silently skip the smoke test forever.
 */
export function rewriteWorkflowPin(content, sha) {
  const pattern = usesLinePattern();
  if (!pattern.test(content)) {
    throw new Error(
      `${WORKFLOW_PATH} has no "uses: ${SITE_ACTIONS_REPO}/.github/workflows/build.yml@..." line to rewrite`,
    );
  }
  return content.replace(pattern, (_match, prefix, trailing) => `${prefix}@${sha}${trailing}`);
}

function git(args, opts) {
  return execFileSync("git", args, { encoding: "utf8", ...opts }).trim();
}

/**
 * Reset `dir`'s `branch` to `dir`'s current `main`, rewrite its `build.yml`
 * pin to `sha`, and force-push it — the one place a literal candidate SHA
 * ever lives (design/0006). Returns the branch's resulting HEAD sha and
 * whether this run actually changed anything: identical back-to-back
 * candidates (a re-run of the same push, say) make this a no-op rather than
 * an empty commit and a needless force-push.
 */
export function pointCanaryAtCandidate({ dir, sha, branch = "canary/promote", run = git }) {
  run(["checkout", "-B", branch], { cwd: dir });

  const filePath = join(dir, WORKFLOW_PATH);
  const original = readFileSync(filePath, "utf8");
  const rewritten = rewriteWorkflowPin(original, sha);

  if (rewritten === original) {
    return { changed: false, sha: run(["rev-parse", "HEAD"], { cwd: dir }) };
  }

  writeFileSync(filePath, rewritten);
  // The runner has no git identity configured by default, and this commit
  // is machine-authored infrastructure, not attributable work — matches
  // `sitebrew-worker`/executor convention of a dedicated non-human author
  // for a commit no human ever reviews (this branch is never merged).
  run(["-c", "user.name=sitebrew-site-actions promote", "-c", "user.email=actions@sitebrewhq.invalid", "commit", "-am", `promote: test candidate ${sha}`], {
    cwd: dir,
  });
  run(["push", "--force", "origin", `HEAD:${branch}`], { cwd: dir });

  return { changed: true, sha: run(["rev-parse", "HEAD"], { cwd: dir }) };
}

async function main() {
  const { CANARY_DIR = "canary", CANDIDATE_SHA, CANARY_BRANCH = "canary/promote" } = process.env;
  if (!CANDIDATE_SHA) throw new Error("missing required env var CANDIDATE_SHA");

  const { changed, sha } = pointCanaryAtCandidate({ dir: CANARY_DIR, sha: CANDIDATE_SHA, branch: CANARY_BRANCH });

  const out = process.env.GITHUB_OUTPUT;
  if (out) {
    appendFileSync(out, `changed=${changed}\n`);
    appendFileSync(out, `sha=${sha}\n`);
  }
  console.log(changed ? `pushed ${CANARY_BRANCH} -> ${sha}` : `${CANARY_BRANCH} already at ${sha}, nothing to push`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.stack ?? String(err));
    process.exit(1);
  });
}
