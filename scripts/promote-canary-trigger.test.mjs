import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { moveCandidateTag, triggerCanaryRebuild } from "./promote-canary-trigger.mjs";

function git(args, opts) {
  return execFileSync("git", args, { encoding: "utf8", ...opts }).trim();
}

async function initBareRepo() {
  const bare = await mkdtemp(join(tmpdir(), "bare-"));
  git(["init", "-q", "--bare", "-b", "main", bare]);
  return bare;
}

/** A checkout with `origin` pointed at `bare` and at least one commit on `main` — real git, same shape `actions/checkout` leaves behind. */
async function seedClone(bare) {
  const clone = await mkdtemp(join(tmpdir(), "clone-"));
  git(["init", "-q", "-b", "main", clone]);
  git(["config", "user.email", "t@example.com"], { cwd: clone });
  git(["config", "user.name", "t"], { cwd: clone });
  await writeFile(join(clone, "README.md"), "seed\n");
  git(["add", "-A"], { cwd: clone });
  git(["commit", "-q", "-m", "seed"], { cwd: clone });
  git(["remote", "add", "origin", bare], { cwd: clone });
  git(["push", "-q", "origin", "main"], { cwd: clone });
  return clone;
}

/**
 * Real local bare repos standing in for `sitebrew-site-actions`/
 * `sitebrew-canary-site` on GitHub — same convention `promote-canary-branch.test.mjs`
 * used for its own git plumbing: nothing mocked, since `git tag`/`git push`
 * are local and deterministic, not the network/credential boundary this
 * repo's other tests mock.
 */
test("moveCandidateTag force-moves candidate to a new sha and pushes it", async () => {
  const bare = await initBareRepo();
  const clone = await seedClone(bare);
  try {
    const first = git(["rev-parse", "HEAD"], { cwd: clone });
    moveCandidateTag({ sha: first, run: (args, opts) => git(args, { cwd: clone, ...opts }) });
    assert.equal(git(["rev-parse", "candidate"], { cwd: bare }), first);

    await writeFile(join(clone, "README.md"), "second\n");
    git(["add", "-A"], { cwd: clone });
    git(["commit", "-q", "-m", "second"], { cwd: clone });
    git(["push", "-q", "origin", "main"], { cwd: clone });
    const second = git(["rev-parse", "HEAD"], { cwd: clone });

    moveCandidateTag({ sha: second, run: (args, opts) => git(args, { cwd: clone, ...opts }) });
    assert.equal(git(["rev-parse", "candidate"], { cwd: bare }), second);
  } finally {
    await rm(clone, { recursive: true, force: true });
    await rm(bare, { recursive: true, force: true });
  }
});

test("triggerCanaryRebuild pushes an empty commit carrying the candidate sha in its message", async () => {
  const bare = await initBareRepo();
  const clone = await seedClone(bare);
  try {
    git(["checkout", "-q", "-b", "canary/promote"], { cwd: clone });
    git(["push", "-q", "origin", "canary/promote"], { cwd: clone });

    const sha = triggerCanaryRebuild({ dir: clone, candidateSha: "cafef00d", branch: "canary/promote" });

    assert.equal(git(["rev-parse", "canary/promote"], { cwd: bare }), sha);
    const message = git(["log", "-1", "--format=%B", sha], { cwd: clone });
    assert.match(message, /promote: test sitebrew-site-actions@cafef00d/);
    assert.deepEqual(git(["diff-tree", "--no-commit-id", "--name-only", "-r", sha], { cwd: clone }), "");
  } finally {
    await rm(clone, { recursive: true, force: true });
    await rm(bare, { recursive: true, force: true });
  }
});

test("triggerCanaryRebuild produces a fresh commit each call, even for the same candidate sha", async () => {
  const bare = await initBareRepo();
  const clone = await seedClone(bare);
  try {
    git(["checkout", "-q", "-b", "canary/promote"], { cwd: clone });
    git(["push", "-q", "origin", "canary/promote"], { cwd: clone });

    const first = triggerCanaryRebuild({ dir: clone, candidateSha: "cafef00d", branch: "canary/promote" });
    const second = triggerCanaryRebuild({ dir: clone, candidateSha: "cafef00d", branch: "canary/promote" });

    assert.notEqual(first, second, "a re-run must still produce a new sha so GitHub sees a synchronize event");
    assert.equal(git(["rev-parse", "canary/promote"], { cwd: bare }), second);
  } finally {
    await rm(clone, { recursive: true, force: true });
    await rm(bare, { recursive: true, force: true });
  }
});
