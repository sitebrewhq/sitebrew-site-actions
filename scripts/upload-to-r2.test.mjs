import { test } from "node:test";
import assert from "node:assert/strict";
import { contentTypeFor, expectedBuildMarker, listFiles, signPutRequest, uploadDirectoryToR2, writeBuildMarker } from "./upload-to-r2.mjs";

test("deploy writes the workflow marker over site-controlled output", async () => {
  const { mkdtemp, mkdir, readFile, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "site-actions-marker-"));
  const marker = expectedBuildMarker({ sourceCommit: "A".repeat(40), imageDigest: `sha256:${"B".repeat(64)}` });
  try {
    await mkdir(join(dir, ".sitebrew"));
    await writeFile(join(dir, ".sitebrew", "build.json"), '{"sourceCommit":"attacker"}\n');
    await writeFile(join(dir, ".sitebrew", "other.txt"), "keep");
    await writeBuildMarker(dir, marker);
    assert.equal((await readFile(join(dir, ".sitebrew", "build.json"))).toString(), marker.toString());
    assert.equal((await readFile(join(dir, ".sitebrew", "other.txt"))).toString(), "keep");
    assert.deepEqual(JSON.parse(marker), { sourceCommit: "a".repeat(40), imageDigest: `sha256:${"b".repeat(64)}` });
    assert.deepEqual(JSON.parse(expectedBuildMarker({ sourceCommit: "a".repeat(40) })), {
      sourceCommit: "a".repeat(40), imageDigest: null,
    });
    assert.throws(() => expectedBuildMarker({ sourceCommit: "attacker" }), /invalid source SHA/);
    assert.throws(() => expectedBuildMarker({ sourceCommit: "a".repeat(40), imageDigest: "" }), /invalid image digest/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("upload rejects a changed marker before any R2 request", async () => {
  const { mkdtemp, mkdir, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "site-actions-marker-"));
  const marker = expectedBuildMarker({ sourceCommit: "a".repeat(40) });
  try {
    await mkdir(join(dir, ".sitebrew"));
    await writeFile(join(dir, ".sitebrew", "build.json"), "tampered\n");
    await writeFile(join(dir, "index.html"), "hi");
    let requests = 0;
    await assert.rejects(uploadDirectoryToR2({
      directory: dir,
      accountId: "acct123",
      bucket: "sitebrew-sites",
      prefix: "sites/x/",
      accessKeyId: "AKID",
      secretAccessKey: "SECRET",
      expectedMarker: marker,
      fetchImpl: async () => { requests++; return { ok: true }; },
      log: () => {},
    }), /build marker does not match workflow values/);
    assert.equal(requests, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("upload sends exactly the workflow marker bytes", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "site-actions-marker-"));
  const marker = expectedBuildMarker({ sourceCommit: "a".repeat(40) });
  try {
    await writeBuildMarker(dir, marker);
    const uploaded = [];
    await uploadDirectoryToR2({
      directory: dir,
      accountId: "acct123",
      bucket: "sitebrew-sites",
      prefix: "sites/x/",
      accessKeyId: "AKID",
      secretAccessKey: "SECRET",
      expectedMarker: marker,
      fetchImpl: async (url, options) => {
        uploaded.push({ url, body: options.body });
        return { ok: true };
      },
      log: () => {},
    });
    assert.equal(uploaded.length, 1);
    assert.ok(uploaded[0].url.endsWith("/.sitebrew/build.json"));
    assert.deepEqual(uploaded[0].body, marker);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

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

/**
 * Regression for the diacritics upload failure (sa#287): `uploadDirectoryToR2`
 * must hand `signPutRequest` a `url` whose path is already percent-encoded
 * exactly once, matching what `fetch` puts on the wire. Reference signature
 * computed independently in a separate script re-implementing AWS's
 * documented canonical-path encoding byte-by-byte (not by calling anything in
 * this module) — confirmed to differ from what the pre-fix code produced for
 * this same path (it signed a doubly-encoded path that disagreed with the
 * actual request, which is exactly the `403 SignatureDoesNotMatch` reported).
 */
test("signPutRequest produces the correct signature for a path containing diacritics, given a pre-encoded url", () => {
  const encodeUriSegment = (s) =>
    encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const encodeUriPath = (p) => p.split("/").map(encodeUriSegment).join("/");
  const key = "sites/site_abc/čtvrtek.png";
  const url = `https://acct123.r2.cloudflarestorage.com/sitebrew-sites/${encodeUriPath(key)}`;

  const { headers } = signPutRequest({
    url,
    body: Buffer.from("hello\n"),
    contentType: "image/png",
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    sessionToken: "FAKESESSIONTOKEN",
    now: new Date("2026-09-01T16:17:56.000Z"),
  });

  assert.equal(
    headers.authorization,
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260901/auto/s3/aws4_request, " +
      "SignedHeaders=content-length;content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token, " +
      "Signature=05cd88074941b632f9b309973ab48893195054b9ae69d436096b256720b68180",
  );
});

test("uploadDirectoryToR2 sends a singly-encoded path for diacritics filenames (no 403 on the real request)", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "site-actions-test-"));
  try {
    await writeFile(join(dir, "čtvrtek.png"), "x");
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      return { ok: true, text: async () => "" };
    };
    await uploadDirectoryToR2({
      directory: dir,
      accountId: "acct123",
      bucket: "sitebrew-sites",
      prefix: "sites/site_abc/",
      accessKeyId: "AKID",
      secretAccessKey: "SECRET",
      fetchImpl,
      log: () => {},
    });
    assert.equal(calls.length, 1);
    const { pathname } = new URL(calls[0]);
    assert.ok(!pathname.includes("%25"), `path must not be double-encoded, got ${pathname}`);
    assert.equal(decodeURIComponent(pathname), "/sitebrew-sites/sites/site_abc/čtvrtek.png");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("uploadDirectoryToR2 runs uploads concurrently instead of one at a time", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "site-actions-test-"));
  try {
    for (let i = 0; i < 5; i++) await writeFile(join(dir, `file-${i}.txt`), "x");

    let inFlight = 0;
    let maxInFlight = 0;
    const fetchImpl = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight--;
      return { ok: true, text: async () => "" };
    };

    const result = await uploadDirectoryToR2({
      directory: dir,
      accountId: "acct123",
      bucket: "sitebrew-sites",
      prefix: "sites/x/",
      accessKeyId: "AKID",
      secretAccessKey: "SECRET",
      fetchImpl,
      log: () => {},
    });

    assert.equal(result.uploaded, 5);
    assert.ok(maxInFlight > 1, `expected overlapping requests, max concurrent was ${maxInFlight}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
