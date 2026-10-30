import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { callSitebrewApi } from "./sitebrew-api-call.mjs";

const execFileAsync = promisify(execFile);
const script = fileURLToPath(new URL("./sitebrew-api-call.mjs", import.meta.url));

async function fixture(t, respond) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, url: req.url, headers: req.headers, body, at: performance.now(), wallAt: Date.now() });
    respond(req, res, requests.length);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  return { url: `http://127.0.0.1:${server.address().port}/v1/actions/upload-token`, requests };
}

async function run(method, url, args = [], env = {}) {
  const options = { timeout: 4500, env: { ...process.env, SITEBREW_API_BUDGET_MS: "3500", ...env } };
  try {
    return { code: 0, ...await execFileAsync(process.execPath, [script, method, url, ...args], options) };
  } catch (error) {
    if (typeof error.code !== "number") throw error;
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

test("success on the first try preserves method, headers, body and stdout", async (t) => {
  const response = '{"accessKeyId":"example","hostname":"pr-1.example"}\n';
  const { url, requests } = await fixture(t, (req, res) => res.end(response));
  const body = '{"ok":true,"message":"hello 🌍"}';
  const result = await run("POST", url, ["-H", "Authorization: Bearer example-token", "-H", "Content-Type: application/json", "-d", body]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, response);
  assert.equal(result.stderr, "");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].headers.authorization, "Bearer example-token");
  assert.equal(requests[0].headers["content-type"], "application/json");
  assert.equal(requests[0].body, body);
});

test("409 honours Retry-After seconds before replaying the same request", async (t) => {
  const { url, requests } = await fixture(t, (req, res, attempt) => {
    if (attempt === 1) res.writeHead(409, { "Retry-After": "1" }).end("sweep claim held");
    else res.end('{"ok":true}');
  });
  const result = await run("POST", url, ["-H", "Authorization: Bearer same-token", "-d", "same body"]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '{"ok":true}');
  assert.match(result.stderr, /^sitebrew-api: 409 from \/v1\/actions\/upload-token, retrying in 1s \([\d.]+\/3.5\)\n$/);
  assert.equal(requests.length, 2);
  assert.ok(requests[1].at - requests[0].at >= 950, "the retry must wait for the hint");
  assert.equal(requests[1].method, requests[0].method);
  assert.equal(requests[1].headers.authorization, requests[0].headers.authorization);
  assert.equal(requests[1].body, requests[0].body);
});

test("429 honours an HTTP-date Retry-After", async (t) => {
  let retryAt;
  const { url, requests } = await fixture(t, (req, res, attempt) => {
    if (attempt === 1) {
      retryAt = Math.ceil(Date.now() / 1000) * 1000 + 1000;
      res.writeHead(429, { "Retry-After": new Date(retryAt).toUTCString() }).end("rate limited");
    } else {
      res.end("done");
    }
  });
  const result = await run("POST", url);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "done");
  assert.match(result.stderr, /sitebrew-api: 429 from \/v1\/actions\/upload-token, retrying in [\d.]+s/);
  assert.equal(requests.length, 2);
  assert.ok(requests[1].wallAt >= retryAt - 20, "the retry must wait until the HTTP-date");
});

test("503 retries and DELETE still has an empty body", async (t) => {
  const { url, requests } = await fixture(t, (req, res, attempt) => {
    if (attempt === 1) res.writeHead(503, { "Retry-After": "0" }).end("maintenance");
    else res.writeHead(204).end();
  });
  const result = await run("DELETE", url);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /sitebrew-api: 503 .* retrying in 0s/);
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.method === "DELETE" && request.body === ""));
});

test("409 forever exits non-zero within the overridden budget with status and excerpt", async (t) => {
  const { url, requests } = await fixture(t, (req, res, attempt) => {
    res.writeHead(409, { "Retry-After": attempt === 1 ? "0" : "75" }).end("sweep claim still held");
  });
  const started = performance.now();
  const result = await run("POST", url, [], { SITEBREW_API_BUDGET_MS: "250" });
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /409 from \/v1\/actions\/upload-token \(retry budget exhausted\): sweep claim still held/);
  assert.ok(requests.length >= 2);
  assert.ok(performance.now() - started < 4000);
});

test("401 fails immediately without a retry and limits the body excerpt", async (t) => {
  const { url, requests } = await fixture(t, (req, res) => {
    res.writeHead(401, { "Retry-After": "1" }).end(`unauthorized ${"x".repeat(1000)}`);
  });
  const result = await run("POST", url);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^sitebrew-api: 401 from \/v1\/actions\/upload-token: unauthorized /);
  assert.doesNotMatch(result.stderr, /retrying/);
  assert.ok(result.stderr.length < 400);
  assert.equal(requests.length, 1);
});

test("secret headers, echoed bearer tokens and response credentials never reach diagnostics", async (t) => {
  const token = "sensitive-bearer-token";
  const secret = 'sensitive-"quoted"-header';
  const { url } = await fixture(t, (req, res, attempt) => {
    const body = JSON.stringify({ message: `denied ${token} ${secret}`, secretAccessKey: "response-secret", sessionToken: "response-token" });
    res.writeHead(attempt === 1 ? 409 : 401, { "Retry-After": "0" }).end(body);
  });
  const result = await run("POST", `${url}?secret=query-secret`, ["-H", `Authorization: Bearer ${token}`, "-H", `X-Secret: ${secret}`]);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /\[REDACTED\]/);
  for (const value of [token, secret, "response-secret", "response-token", "query-secret"]) {
    assert.ok(!result.stderr.includes(value), `diagnostics must redact ${value}`);
    assert.ok(!result.stderr.includes(JSON.stringify(value).slice(1, -1)), "JSON escaping must not bypass redaction");
  }
});

test("Retry-After defaults, caps, invalid values and past dates use the correct waits", async (t) => {
  // Advance a monotonic clock when sleeping, while using a real local HTTP
  // server. This verifies production-length waits without slowing the suite.
  const hints = [undefined, "invalid", "9999", "-1", "Fri, 01 Jan 2100 00:00:00 GMT", "Thu, 01 Jan 1970 00:00:00 GMT"];
  const { url, requests } = await fixture(t, (req, res, attempt) => {
    if (attempt > hints.length) return res.end("recovered");
    const hint = hints[attempt - 1];
    res.writeHead(503, hint === undefined ? {} : { "Retry-After": hint }).end("unavailable");
  });
  let clock = 0;
  const waits = [];
  const logs = [];
  assert.equal(await callSitebrewApi({
    method: "POST", url, now: () => clock, wallNow: () => Date.UTC(2026, 9, 30),
    sleepImpl: async (ms) => { waits.push(ms); clock += ms; },
    log: (line) => logs.push(line),
  }), "recovered");
  assert.deepEqual(waits, [75000, 75000, 120000, 75000, 120000, 0]);
  assert.equal(requests.length, 7);
  assert.equal(logs[0], "sitebrew-api: 503 from /v1/actions/upload-token, retrying in 75s (0/960)");
});

test("other 5xx statuses get at most three retries with 5-second backoff", async (t) => {
  const statuses = [500, 502, 504, 500];
  const { url, requests } = await fixture(t, (req, res, attempt) => {
    res.writeHead(statuses[attempt - 1], { "Retry-After": "100" }).end("server error");
  });
  let clock = 0;
  const waits = [];
  await assert.rejects(callSitebrewApi({
    method: "POST", url, now: () => clock,
    sleepImpl: async (ms) => { waits.push(ms); clock += ms; }, log: () => {},
  }), /500 from .*: server error/);
  assert.deepEqual(waits, [5000, 5000, 5000]);
  assert.equal(requests.length, 4);
});

test("the default 16-minute budget bounds repeated 409 waits", async (t) => {
  const { url, requests } = await fixture(t, (req, res) => res.writeHead(409).end("claim held"));
  let clock = 0;
  const waits = [];
  await assert.rejects(callSitebrewApi({
    method: "POST", url, now: () => clock,
    sleepImpl: async (ms) => { waits.push(ms); clock += ms; }, log: () => {},
  }), /409 from .*retry budget exhausted.*claim held/);
  assert.equal(clock, 960000);
  assert.deepEqual(waits, [...Array(12).fill(75000), 60000]);
  assert.equal(requests.length, 13);
});

test("the budget also aborts a stalled response body", async (t) => {
  const { url } = await fixture(t, (req, res) => {
    res.writeHead(503);
    res.write("unfinished response");
  });
  const result = await run("POST", url, [], { SITEBREW_API_BUDGET_MS: "200" });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /503 from .*retry budget exhausted/);
  assert.equal(result.stdout, "");
});

test("redirects return their body without following or forwarding authorization", async (t) => {
  const { url, requests } = await fixture(t, (req, res) => {
    res.writeHead(302, { Location: "/redirect-target" }).end("redirect body");
  });
  const result = await run("POST", url, ["-H", "Authorization: Bearer example-token"]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "redirect body");
  assert.equal(result.stderr, "");
  assert.equal(requests.length, 1);
});
