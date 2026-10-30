#!/usr/bin/env node
/**
 * Node 20, no dependencies. Usage: sitebrew-api-call.mjs METHOD URL
 * [-H 'Header: value']... [-d 'body']. Only response bodies go to stdout.
 * SITEBREW_API_BUDGET_MS can shorten the 16-minute budget for local tests.
 * Preview sweep claims (sitebrew-platform #548) return 409 + Retry-After;
 * their crash recovery can take 15 minutes, so allow one minute of margin.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const BUDGET_MS = 16 * 60 * 1000;

function retryAfterMs(value, now) {
  const hint = value?.trim() ?? "";
  let delay = 75000;
  if (/^\d+$/.test(hint)) delay = Number(hint) * 1000;
  else if (/[a-z]/i.test(hint) && Number.isFinite(Date.parse(hint))) delay = Date.parse(hint) - now;
  return Math.min(120000, Math.max(0, delay));
}

function bodyExcerpt(body, headers) {
  // Error responses may echo credentials. Redact credential fields and all
  // supplied header values (including a bearer token without its scheme).
  let text = body;
  try {
    text = JSON.stringify(JSON.parse(text, (key, value) =>
      /authorization|cookie|token|secret|password|credential|access.?key|api.?key|private.?key/i.test(key)
        ? "[REDACTED]" : value));
  } catch {
    text = text.replace(/((?:authorization|cookie|\w*(?:token|secret|password|credential|key))\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]");
  }
  for (const [name, value] of headers) {
    const secrets = [value];
    if (name === "authorization") secrets.push(value.replace(/^\S+\s+/, ""));
    for (const secret of secrets.filter(Boolean)) {
      for (const form of [JSON.stringify(secret).slice(1, -1), secret]) {
        text = text.split(form).join("[REDACTED]");
      }
    }
  }
  return text.replace(/[\s\x00-\x1f\x7f]+/g, " ").slice(0, 300);
}

export async function callSitebrewApi({
  method, url, headers = {}, body, budgetMs = BUDGET_MS,
  fetchImpl = fetch,
  sleepImpl = (ms, signal) => sleep(ms, undefined, { signal }),
  now = () => performance.now(),
  wallNow = Date.now,
  log = (line) => console.error(line),
}) {
  if (!Number.isInteger(budgetMs) || budgetMs <= 0 || budgetMs > BUDGET_MS) {
    throw new Error("sitebrew-api: budget must be between 1 and 960000 ms");
  }
  const path = new URL(url).pathname;
  headers = new Headers(headers);
  const started = now();
  const elapsed = () => now() - started;
  const seconds = (ms) => Number((ms / 1000).toFixed(3));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  let status;
  let excerpt = "";
  let serverRetries = 0;
  const failure = (reason = "") => new Error(
    `sitebrew-api: ${status ?? "no response"} from ${path}${reason ? ` (${reason})` : ""}${excerpt ? `: ${excerpt}` : ""}`,
  );
  try {
    for (;;) {
      if (elapsed() >= budgetMs) throw failure("retry budget exhausted");
      let response;
      let responseBody;
      try {
        // Match curl without -L: do not forward credentials across redirects.
        response = await fetchImpl(url, { method, headers, body, redirect: "manual", signal: controller.signal });
        status = response.status;
        excerpt = "";
        responseBody = await response.text();
      } catch {
        // Transport errors can include request details; never print them.
        throw failure(controller.signal.aborted ? "retry budget exhausted" : "request failed");
      }
      // curl -f also accepts 3xx, returning their body without following them.
      if (status < 400) return responseBody;
      excerpt = bodyExcerpt(responseBody, headers);
      let waitMs;
      if ([409, 429, 503].includes(status)) {
        waitMs = retryAfterMs(response.headers.get("retry-after"), wallNow());
      } else if (status >= 500 && status <= 599 && serverRetries < 3) {
        serverRetries++;
        waitMs = 5000;
      } else {
        throw failure();
      }
      const remaining = budgetMs - elapsed();
      if (remaining <= 0) throw failure("retry budget exhausted");
      waitMs = Math.min(waitMs, remaining);
      log(`sitebrew-api: ${status} from ${path}, retrying in ${seconds(waitMs)}s (${seconds(elapsed())}/${seconds(budgetMs)})`);
      try {
        await sleepImpl(waitMs, controller.signal);
      } catch {
        throw failure("retry budget exhausted");
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  let request;
  try {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: { header: { type: "string", short: "H", multiple: true }, data: { type: "string", short: "d" } },
    });
    if (positionals.length !== 2) throw new Error();
    const [method, url] = positionals;
    if (!["http:", "https:"].includes(new URL(url).protocol) || !/^[A-Z]+$/.test(method)) throw new Error();
    const headers = new Headers();
    for (const header of values.header ?? []) {
      const colon = header.indexOf(":");
      if (colon <= 0) throw new Error();
      headers.append(header.slice(0, colon).trim(), header.slice(colon + 1).trim());
    }
    request = { method, url, headers, body: values.data };
  } catch {
    // parseArgs errors may contain secret argument values.
    throw new Error("sitebrew-api: expected METHOD URL [-H 'Header: value']... [-d 'body']");
  }
  const body = await callSitebrewApi({
    ...request,
    budgetMs: Number(process.env.SITEBREW_API_BUDGET_MS ?? BUDGET_MS),
  });
  process.stdout.write(body);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
