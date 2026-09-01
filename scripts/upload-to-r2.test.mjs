import { test } from "node:test";
import assert from "node:assert/strict";
import { contentTypeFor, listFiles, signPutRequest } from "./upload-to-r2.mjs";

test("contentTypeFor matches sitebrew-worker's guessType for common extensions", () => {
  assert.equal(contentTypeFor("index.html"), "text/html; charset=utf-8");
  assert.equal(contentTypeFor("style.CSS"), "text/css; charset=utf-8");
  assert.equal(contentTypeFor("app.js"), "text/javascript; charset=utf-8");
  assert.equal(contentTypeFor("favicon.ico"), "image/x-icon");
  assert.equal(contentTypeFor("no-extension"), "application/octet-stream");
});

test("listFiles walks nested directories and sorts the result", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "site-actions-test-"));
  try {
    await mkdir(join(dir, "css"));
    await writeFile(join(dir, "index.html"), "hi");
    await writeFile(join(dir, "css", "style.css"), "body{}");
    assert.deepEqual(await listFiles(dir), ["css/style.css", "index.html"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * Frozen reference signature — independently computed with the widely-used
 * `aws4` npm package for this exact request (same date, path, headers, body,
 * credentials) and confirmed byte-identical before this test was written.
 * Guards the hand-rolled SigV4 implementation against a silent regression;
 * see this file's own module doc for why there's no runtime dependency on
 * `aws4`/`aws4fetch` here instead.
 */
test("signPutRequest produces a byte-identical Authorization header to the aws4 reference implementation", () => {
  const body = Buffer.from("hello\n");
  const { headers } = signPutRequest({
    url: "https://acct123.r2.cloudflarestorage.com/sitebrew-sites/sites/site_abc/index.html",
    body,
    contentType: "text/html; charset=utf-8",
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    sessionToken: "FAKESESSIONTOKEN",
    now: new Date("2026-09-01T16:17:56.000Z"),
  });

  assert.equal(
    headers.authorization,
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260901/auto/s3/aws4_request, " +
      "SignedHeaders=content-length;content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token, " +
      "Signature=1e412937c1778b979efd4d6c47d9c263861289296a9314d47d1b667413ef23ff",
  );
  assert.equal(headers["content-length"], "6");
  assert.equal(headers["x-amz-date"], "20260901T161756Z");
});

test("signPutRequest omits x-amz-security-token when no sessionToken is given", () => {
  const { headers } = signPutRequest({
    url: "https://acct123.r2.cloudflarestorage.com/sitebrew-sites/sites/x/a.txt",
    body: Buffer.from("x"),
    contentType: "text/plain; charset=utf-8",
    accessKeyId: "AKID",
    secretAccessKey: "SECRET",
    now: new Date("2026-09-01T00:00:00.000Z"),
  });
  assert.equal("x-amz-security-token" in headers, false);
  assert.ok(!headers.authorization.includes("x-amz-security-token"));
});
