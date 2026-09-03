import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateWorkflowRuns, waitForCandidateRun } from "./wait-for-canary-run.mjs";

test("evaluateWorkflowRuns: not done when no workflow run has started yet", () => {
  assert.deepEqual(evaluateWorkflowRuns([]), { done: false });
});

test("evaluateWorkflowRuns: not done while any workflow run is still in progress", () => {
  assert.deepEqual(
    evaluateWorkflowRuns([
      { status: "completed", conclusion: "success" },
      { status: "in_progress", conclusion: null },
    ]),
    { done: false },
  );
});

test("evaluateWorkflowRuns: success once every workflow run is completed and successful", () => {
  assert.deepEqual(
    evaluateWorkflowRuns([{ status: "completed", conclusion: "success" }]),
    { done: true, conclusion: "success" },
  );
});

test("evaluateWorkflowRuns: failure if any completed workflow run did not conclude success", () => {
  assert.deepEqual(
    evaluateWorkflowRuns([
      { status: "completed", conclusion: "success" },
      { status: "completed", conclusion: "failure" },
    ]),
    { done: true, conclusion: "failure" },
  );
});

test("waitForCandidateRun resolves success as soon as a terminal state appears, without over-polling", async () => {
  let calls = 0;
  const sleeps = [];
  const conclusion = await waitForCandidateRun({
    repo: "sitebrewhq/sitebrew-canary-site",
    sha: "cafef00d",
    token: "t",
    maxAttempts: 5,
    fetchImpl: async (url, init) => {
      calls += 1;
      assert.equal(url, "https://api.github.com/repos/sitebrewhq/sitebrew-canary-site/actions/runs?head_sha=cafef00d");
      assert.equal(init.headers.authorization, "Bearer t");
      const workflow_runs = calls < 2 ? [] : [{ status: "completed", conclusion: "success" }];
      return { ok: true, json: async () => ({ workflow_runs }) };
    },
    sleepImpl: async (ms) => sleeps.push(ms),
  });
  assert.equal(conclusion, "success");
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [15000]);
});

test("waitForCandidateRun reports failure without waiting out the rest of maxAttempts", async () => {
  let calls = 0;
  const conclusion = await waitForCandidateRun({
    repo: "r",
    sha: "s",
    token: "t",
    maxAttempts: 10,
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, json: async () => ({ workflow_runs: [{ status: "completed", conclusion: "failure" }] }) };
    },
    sleepImpl: async () => {
      throw new Error("should not sleep once a terminal conclusion is known");
    },
  });
  assert.equal(conclusion, "failure");
  assert.equal(calls, 1);
});

test("waitForCandidateRun gives up and reports timeout after maxAttempts, sleeping between but not after the last attempt", async () => {
  let sleepCount = 0;
  let fetchCount = 0;
  const conclusion = await waitForCandidateRun({
    repo: "r",
    sha: "s",
    token: "t",
    maxAttempts: 3,
    fetchImpl: async () => {
      fetchCount += 1;
      return { ok: true, json: async () => ({ workflow_runs: [] }) };
    },
    sleepImpl: async () => {
      sleepCount += 1;
    },
  });
  assert.equal(conclusion, "timeout");
  assert.equal(fetchCount, 3);
  assert.equal(sleepCount, 2);
});

test("waitForCandidateRun throws on a non-ok response instead of treating it as pending", async () => {
  await assert.rejects(
    waitForCandidateRun({
      repo: "r",
      sha: "s",
      token: "t",
      fetchImpl: async () => ({ ok: false, status: 403, text: async () => "missing actions:read permission" }),
    }),
    /403/,
  );
});
