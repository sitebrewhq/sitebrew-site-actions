import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pointCanaryAtCandidate, rewriteWorkflowPin } from "./promote-canary-branch.mjs";

function git(args, opts) {
  return execFileSync("git", args, { encoding: "utf8", ...opts }).trim();
}

test("rewriteWorkflowPin swaps only the ref, leaving the rest of the line and file untouched", () => {
  const content = [
    "jobs:",
    "  build:",
    "    uses: sitebrewhq/sitebrew-site-actions/.github/workflows/build.yml@stable",
    "",
  ].join("\n");
  const rewritten = rewriteWorkflowPin(content, "cafef00dcafef00dcafef00dcafef00dcafef00d");
  assert.equal(
    rewritten,
    [
      "jobs:",
      "  build:",
      "    uses: sitebrewhq/sitebrew-site-actions/.github/workflows/build.yml@cafef00dcafef00dcafef00dcafef00dcafef00d",
      "",
    ].join("\n"),
  );
});

test("rewriteWorkflowPin preserves a trailing comment after the ref", () => {
  const content = "    uses: sitebrewhq/sitebrew-site-actions/.github/workflows/build.yml@old-sha # v0.1\n";
  const rewritten = rewriteWorkflowPin(content, "new-sha");
  assert.equal(rewritten, "    uses: sitebrewhq/sitebrew-site-actions/.github/workflows/build.yml@new-sha # v0.1\n");
});

test("rewriteWorkflowPin throws when the expected uses: line is missing entirely", () => {
  assert.throws(
    () => rewriteWorkflowPin("jobs:\n  build:\n    runs-on: ubuntu-latest\n", "abc"),
    /no "uses: sitebrewhq\/sitebrew-site-actions/,
  );
});

test("rewriteWorkflowPin does not touch an unrelated uses: line for a different workflow", () => {
  const content = "    uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.2.2\n";
  assert.throws(() => rewriteWorkflowPin(content, "abc"), /no "uses:/);
});

async function initBareRepo() {
  const bare = await mkdtemp(join(tmpdir(), "site-actions-bare-"));
  git(["init", "-q", "--bare", "-b", "main", bare]);
  return bare;
}

/** A `main` shaped like design/0006's steady state: `build.yml` calling `@stable`. */
async function seedCanaryMain(bare) {
  const seed = await mkdtemp(join(tmpdir(), "site-actions-seed-"));
  git(["init", "-q", "-b", "main", seed]);
  git(["config", "user.email", "t@example.com"], { cwd: seed });
  git(["config", "user.name", "t"], { cwd: seed });
  await mkdir(join(seed, ".github", "workflows"), { recursive: true });
  await writeFile(
    join(seed, ".github", "workflows", "build.yml"),
    "jobs:\n  build:\n    uses: sitebrewhq/sitebrew-site-actions/.github/workflows/build.yml@stable\n",
  );
  git(["add", "-A"], { cwd: seed });
  git(["commit", "-q", "-m", "seed"], { cwd: seed });
  git(["remote", "add", "origin", bare], { cwd: seed });
  git(["push", "-q", "origin", "main"], { cwd: seed });
  await rm(seed, { recursive: true, force: true });
}

async function readCanaryPromoteBuildYml(bare) {
  const verify = await mkdtemp(join(tmpdir(), "site-actions-verify-"));
  try {
    git(["clone", "-q", "--branch", "canary/promote", bare, verify]);
    return await readFile(join(verify, ".github", "workflows", "build.yml"), "utf8");
  } finally {
    await rm(verify, { recursive: true, force: true });
  }
}

/**
 * Exercises `pointCanaryAtCandidate` against a real local bare repo standing
 * in for `sitebrew-canary-site` on GitHub — real `git` (the same binary the
 * Actions runner provides), nothing mocked here, since git plumbing is
 * local and deterministic, not the network/credential boundary this repo's
 * other tests mock (`upload-to-r2.test.mjs` mocks `fetch`, the true
 * boundary there; a temp bare repo plays the same role for `git push` here).
 */
test("pointCanaryAtCandidate force-pushes canary/promote with the rewritten pin", async () => {
  const bare = await initBareRepo();
  const cloneA = await mkdtemp(join(tmpdir(), "site-actions-clone-a-"));
  try {
    await seedCanaryMain(bare);

    git(["clone", "-q", bare, cloneA]);
    const first = pointCanaryAtCandidate({ dir: cloneA, sha: "cafef00d1", run: git });
    assert.equal(first.changed, true);

    const buildYmlAfterFirst = await readCanaryPromoteBuildYml(bare);
    assert.match(buildYmlAfterFirst, /@cafef00d1$/m);
  } finally {
    await rm(cloneA, { recursive: true, force: true });
    await rm(bare, { recursive: true, force: true });
  }
});

/**
 * `main`'s own `build.yml` always calls `@stable` (design/0006), so a fresh
 * per-run checkout (`promote.yml`'s own `actions/checkout` every job
 * execution) always sees a diff against a *new* candidate SHA — real
 * back-to-back promotions are never a no-op. The no-op path only exists for
 * an in-place re-run against the *same* checkout that already carries the
 * candidate's own rewrite (e.g. a retried step within one job) — this test
 * exercises exactly that, not two independent clones.
 */
test("pointCanaryAtCandidate is a no-op when re-run in place against a checkout that already has the candidate applied", async () => {
  const bare = await initBareRepo();
  const clone = await mkdtemp(join(tmpdir(), "site-actions-clone-inplace-"));
  try {
    await seedCanaryMain(bare);

    git(["clone", "-q", bare, clone]);
    const first = pointCanaryAtCandidate({ dir: clone, sha: "cafef00d1", run: git });
    assert.equal(first.changed, true);

    const second = pointCanaryAtCandidate({ dir: clone, sha: "cafef00d1", run: git });
    assert.equal(second.changed, false, "re-promoting the same candidate in place should not push an empty commit");
    assert.equal(second.sha, first.sha);
  } finally {
    await rm(clone, { recursive: true, force: true });
    await rm(bare, { recursive: true, force: true });
  }
});

test("pointCanaryAtCandidate overwrites a previous candidate rather than merging with it", async () => {
  const bare = await initBareRepo();
  try {
    await seedCanaryMain(bare);

    const cloneA = await mkdtemp(join(tmpdir(), "site-actions-clone2-a-"));
    git(["clone", "-q", bare, cloneA]);
    pointCanaryAtCandidate({ dir: cloneA, sha: "first-candidate", run: git });
    await rm(cloneA, { recursive: true, force: true });

    // main on the bare repo never moved, so this second run still starts
    // from main (not the previous canary/promote branch) and its candidate
    // fully replaces the first one — this is what "canary/promote is
    // overwritten every promotion" (design/0006) means in practice.
    const cloneB = await mkdtemp(join(tmpdir(), "site-actions-clone2-b-"));
    git(["clone", "-q", bare, cloneB]);
    const second = pointCanaryAtCandidate({ dir: cloneB, sha: "second-candidate", run: git });
    assert.equal(second.changed, true);
    await rm(cloneB, { recursive: true, force: true });

    const buildYml = await readCanaryPromoteBuildYml(bare);
    assert.match(buildYml, /@second-candidate$/m);
    assert.doesNotMatch(buildYml, /first-candidate/);
  } finally {
    await rm(bare, { recursive: true, force: true });
  }
});
