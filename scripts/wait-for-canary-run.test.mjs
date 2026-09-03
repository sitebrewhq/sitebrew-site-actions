import { test } from "node:test";
import assert from "node:assert/strict";
import { waitForCandidateStatus } from "./wait-for-canary-run.mjs";

const fakeMintToken = (tokens = ["t1", "t2", "t3", "t4", "t5"]) => {
  let calls = 0;
  return { mintToken: async () => tokens[Math.min(calls++, tokens.length - 1)], get calls() { return calls; } };
};

test("waitForCandidateStatus resolves success as soon as a terminal state appears, minting a fresh token each attempt", async () => {
  const mint = fakeMintToken();
  let fetchCalls = 0;
  const sleeps = [];
  const conclusion = await waitForCandidateStatus({
    apiBaseUrl: "https://api-staging.sitebrew.app",
    audience: "sitebrew-actions-staging",
    sha: "cafef00d",
    maxAttempts: 5,
    mintToken: mint.mintToken,
    fetchImpl: async (url, init) => {
      fetchCalls += 1;
      assert.equal(url, "https://api-staging.sitebrew.app/v1/actions/canary-status");
      assert.equal(init.method, "POST");
      assert.equal(init.headers.authorization, `Bearer t${fetchCalls}`);
      assert.deepEqual(JSON.parse(init.body), { sha: "cafef00d" });
      const conclusion = fetchCalls < 2 ? "pending" : "success";
      return { ok: true, json: async () => ({ conclusion }) };
    },
    sleepImpl: async (ms) => sleeps.push(ms),
  });
  assert.equal(conclusion, "success");
  assert.equal(fetchCalls, 2);
  assert.equal(mint.calls, 2, "a fresh token must be minted for every attempt, not reused");
  assert.deepEqual(sleeps, [15000]);
});

test("waitForCandidateStatus reports failure without waiting out the rest of maxAttempts", async () => {
  const mint = fakeMintToken();
  let calls = 0;
  const conclusion = await waitForCandidateStatus({
    apiBaseUrl: "https://api-staging.sitebrew.app",
    audience: "a",
    sha: "s",
    maxAttempts: 10,
    mintToken: mint.mintToken,
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, json: async () => ({ conclusion: "failure" }) };
    },
    sleepImpl: async () => {
      throw new Error("should not sleep once a terminal conclusion is known");
    },
  });
  assert.equal(conclusion, "failure");
  assert.equal(calls, 1);
});

test("waitForCandidateStatus gives up and reports timeout after maxAttempts, sleeping between but not after the last attempt", async () => {
  const mint = fakeMintToken();
  let sleepCount = 0;
  let fetchCount = 0;
  const conclusion = await waitForCandidateStatus({
    apiBaseUrl: "https://api-staging.sitebrew.app",
    audience: "a",
    sha: "s",
    maxAttempts: 3,
    mintToken: mint.mintToken,
    fetchImpl: async () => {
      fetchCount += 1;
      return { ok: true, json: async () => ({ conclusion: "pending" }) };
    },
    sleepImpl: async () => {
      sleepCount += 1;
    },
  });
  assert.equal(conclusion, "timeout");
  assert.equal(fetchCount, 3);
  assert.equal(sleepCount, 2);
});

test("waitForCandidateStatus throws on a non-ok response instead of treating it as pending", async () => {
  const mint = fakeMintToken();
  await assert.rejects(
    waitForCandidateStatus({
      apiBaseUrl: "https://api-staging.sitebrew.app",
      audience: "a",
      sha: "s",
      mintToken: mint.mintToken,
      fetchImpl: async () => ({ ok: false, status: 502, text: async () => "GitHub answered 500" }),
    }),
    /502/,
  );
});
