import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateCheckRuns, waitForCandidateCheck } from "./wait-for-canary-check.mjs";

test("evaluateCheckRuns: not done when no check-run has started yet", () => {
  assert.deepEqual(evaluateCheckRuns([]), { done: false });
});

test("evaluateCheckRuns: not done while any check-run is still in progress", () => {
  assert.deepEqual(
    evaluateCheckRuns([
      { status: "completed", conclusion: "success" },
      { status: "in_progress", conclusion: null },
    ]),
    { done: false },
  );
});

test("evaluateCheckRuns: success once every check-run is completed and successful", () => {
  assert.deepEqual(
    evaluateCheckRuns([
      { status: "completed", conclusion: "success" },
      { status: "completed", conclusion: "success" },
    ]),
    { done: true, conclusion: "success" },
  );
});

test("evaluateCheckRuns: failure if any completed check-run did not conclude success", () => {
  assert.deepEqual(
    evaluateCheckRuns([
      { status: "completed", conclusion: "success" },
      { status: "completed", conclusion: "failure" },
    ]),
    { done: true, conclusion: "failure" },
  );
});

test("waitForCandidateCheck resolves success as soon as a terminal state appears, without over-polling", async () => {
  let calls = 0;
  const sleeps = [];
  const conclusion = await waitForCandidateCheck({
    repo: "sitebrewhq/sitebrew-canary-site",
    sha: "cafef00d",
    token: "t",
    maxAttempts: 5,
    fetchImpl: async (url, init) => {
      calls += 1;
      assert.equal(url, "https://api.github.com/repos/sitebrewhq/sitebrew-canary-site/commits/cafef00d/check-runs");
      assert.equal(init.headers.authorization, "Bearer t");
      const check_runs = calls < 2 ? [] : [{ status: "completed", conclusion: "success" }];
      return { ok: true, json: async () => ({ check_runs }) };
    },
    sleepImpl: async (ms) => sleeps.push(ms),
  });
  assert.equal(conclusion, "success");
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [15000]);
});

test("waitForCandidateCheck reports failure without waiting out the rest of maxAttempts", async () => {
  let calls = 0;
  const conclusion = await waitForCandidateCheck({
    repo: "r",
    sha: "s",
    token: "t",
    maxAttempts: 10,
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, json: async () => ({ check_runs: [{ status: "completed", conclusion: "failure" }] }) };
    },
    sleepImpl: async () => {
      throw new Error("should not sleep once a terminal conclusion is known");
    },
  });
  assert.equal(conclusion, "failure");
  assert.equal(calls, 1);
});

test("waitForCandidateCheck gives up and reports timeout after maxAttempts, sleeping between but not after the last attempt", async () => {
  let sleepCount = 0;
  let fetchCount = 0;
  const conclusion = await waitForCandidateCheck({
    repo: "r",
    sha: "s",
    token: "t",
    maxAttempts: 3,
    fetchImpl: async () => {
      fetchCount += 1;
      return { ok: true, json: async () => ({ check_runs: [] }) };
    },
    sleepImpl: async () => {
      sleepCount += 1;
    },
  });
  assert.equal(conclusion, "timeout");
  assert.equal(fetchCount, 3);
  assert.equal(sleepCount, 2);
});

test("waitForCandidateCheck throws on a non-ok response instead of treating it as pending", async () => {
  await assert.rejects(
    waitForCandidateCheck({
      repo: "r",
      sha: "s",
      token: "t",
      fetchImpl: async () => ({ ok: false, status: 403, text: async () => "missing checks:read permission" }),
    }),
    /403/,
  );
});
