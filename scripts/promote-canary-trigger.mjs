#!/usr/bin/env node
/**
 * Move this repository's own `candidate` tag to the commit under promotion,
 * then push a marker commit to `sitebrew-canary-site`'s standing
 * `canary/promote` branch to force a fresh `pull_request: synchronize`
 * build against it — design/0006's promotion mechanism, "third path"
 * (DevGuru, 2026-09-03).
 *
 * An earlier version of this script force-pushed a rewritten `build.yml`
 * (`uses: .../build.yml@<literal candidate SHA>`) to `canary/promote` on
 * every promotion. That needed a `workflows` GitHub App permission nobody
 * has granted `sitebrewapp`, and the executor-token mint's own
 * `assertNoElevatedExecutorPermissions` guard (`sitebrew-api`) forbids
 * requesting it at all (ADR-0003 §5, §8) — a real security boundary, not an
 * oversight. `canary/promote`'s `build.yml` is instead a **permanent**
 * file, set up once by hand with a real PAT (the same one-time-manual shape
 * as bootstrapping the `stable` tag itself): it calls
 * `uses: sitebrewhq/sitebrew-site-actions/.github/workflows/build.yml@candidate`
 * — a fixed but *moving* tag, resolved fresh by GitHub on every run exactly
 * the way `@stable` is (design/0006's own `job_workflow_ref` note). Moving
 * that tag needs only `contents: write` on this repository's own ref — no
 * cross-repo credential, and nothing under `.github/workflows/` on
 * *this* repo changes either, since the tag is a ref, not a file.
 *
 * `candidate` is this workflow's own resource, exclusively — nothing else
 * should ever move it, the same rule `stable` already has.
 *
 * The marker commit on `canary/promote` carries the candidate SHA in its
 * own message (an earlier, file-rewriting version of this mechanism got
 * that same audit trail for free from its diff, DevGuru 2026-09-03) — an
 * anonymous empty commit would make "which site-actions commit did this run
 * validate" unrecoverable from canary's own history.
 *
 * Kept dependency-free like `upload-to-r2.mjs`: this shells out to the
 * `git` binary the Actions runner already provides rather than reaching for
 * an npm git library, for the same reason that script hand-rolls SigV4 —
 * one more package is one more supply-chain surface for a script a
 * customer-triggered event (a push to this repo's own `main`) causes to run
 * with a real write credential.
 */

import { execFileSync } from "node:child_process";

function git(args, opts) {
  return execFileSync("git", args, { encoding: "utf8", ...opts }).trim();
}

/**
 * Force this repository's own `candidate` tag to `sha` and push it —
 * `run`'s checkout already has push access to *this* repo via
 * `actions/checkout`'s persisted credential (the job's own `contents: write`
 * permission), the same one the later "Promote stable" step reuses.
 */
export function moveCandidateTag({ sha, run = git }) {
  run(["tag", "-f", "candidate", sha]);
  run(["push", "--force", "origin", "candidate"]);
}

/**
 * Push an empty, audit-labelled commit onto `canary/promote` (already
 * checked out in `dir`, authenticated with the minted canary-scoped
 * installation token) to force GitHub to re-run the branch's standing PR
 * against `candidate`'s new target. Returns the resulting commit's own SHA
 * — what `wait-for-canary-run.mjs` polls for, same as the file-rewrite
 * version's commit SHA before it.
 */
export function triggerCanaryRebuild({ dir, candidateSha, branch = "canary/promote", run = git }) {
  run(
    [
      "-c",
      "user.name=sitebrew-site-actions promote",
      "-c",
      "user.email=actions@sitebrewhq.invalid",
      "commit",
      "--allow-empty",
      "-m",
      `promote: test sitebrew-site-actions@${candidateSha}`,
    ],
    { cwd: dir },
  );
  run(["push", "origin", `HEAD:${branch}`], { cwd: dir });
  return run(["rev-parse", "HEAD"], { cwd: dir });
}

async function main() {
  const { CANARY_DIR = "canary", CANDIDATE_SHA, CANARY_BRANCH = "canary/promote" } = process.env;
  if (!CANDIDATE_SHA) throw new Error("missing required env var CANDIDATE_SHA");

  moveCandidateTag({ sha: CANDIDATE_SHA });
  const sha = triggerCanaryRebuild({ dir: CANARY_DIR, candidateSha: CANDIDATE_SHA, branch: CANARY_BRANCH });

  const out = process.env.GITHUB_OUTPUT;
  if (out) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(out, `sha=${sha}\n`);
  }
  console.log(`candidate -> ${CANDIDATE_SHA}, ${CANARY_BRANCH} -> ${sha}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.stack ?? String(err));
    process.exit(1);
  });
}
