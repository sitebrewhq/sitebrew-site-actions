import { test } from "node:test";
import assert from "node:assert/strict";
import { listFiles, signDeleteRequest, deleteDirectoryFromR2 } from "./delete-from-r2.mjs";

test("listFiles walks nested directories and sorts the result", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "site-actions-delete-test-"));
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
 * `aws4` npm package for this exact request (same date, path, credentials)
 * and confirmed byte-identical before this test was written, the same way
 * `upload-to-r2.test.mjs`'s own PUT reference was. Guards this file's
 * hand-rolled DELETE signing against a silent regression.
 */
test("signDeleteRequest produces a byte-identical Authorization header to the aws4 reference implementation", () => {
  const { headers } = signDeleteRequest({
    url: "https://acct123.r2.cloudflarestorage.com/sitebrew-sites/sites/pr-7--site_abc/index.html",
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    sessionToken: "FAKESESSIONTOKEN",
    now: new Date("2026-09-01T16:17:56.000Z"),
  });

  assert.equal(
    headers.authorization,
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260901/auto/s3/aws4_request, " +
      "SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token, " +
      "Signature=63aabd4a9460e0a79d371f5985840cf0bf3ecbefe41b199139b6b830c18ee0dc",
  );
  assert.equal(headers["x-amz-date"], "20260901T161756Z");
  assert.equal(headers["x-amz-content-sha256"], "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("signDeleteRequest omits x-amz-security-token when no sessionToken is given", () => {
  const { headers } = signDeleteRequest({
    url: "https://acct123.r2.cloudflarestorage.com/sitebrew-sites/sites/x/a.txt",
    accessKeyId: "AKID",
    secretAccessKey: "SECRET",
    now: new Date("2026-09-01T00:00:00.000Z"),
  });
  assert.equal("x-amz-security-token" in headers, false);
  assert.ok(!headers.authorization.includes("x-amz-security-token"));
});

test("deleteDirectoryFromR2 issues one DELETE per file, keyed by prefix + relative path", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "site-actions-delete-test-"));
  try {
    await mkdir(join(dir, "css"));
    await writeFile(join(dir, "index.html"), "hi");
    await writeFile(join(dir, "css", "style.css"), "body{}");

    const requests = [];
    const fetchImpl = async (url, init) => {
      requests.push({ url, method: init.method });
      return new Response(null, { status: 204 });
    };

    const result = await deleteDirectoryFromR2({
      directory: dir,
      accountId: "acct123",
      bucket: "sitebrew-sites",
      prefix: "sites/pr-7--site_abc/",
      accessKeyId: "AKID",
      secretAccessKey: "SECRET",
      sessionToken: "TOKEN",
      fetchImpl,
      log: () => {},
    });

    assert.equal(result.deleted, 2);
    assert.deepEqual(
      requests.map((r) => r.url).sort(),
      [
        "https://acct123.r2.cloudflarestorage.com/sitebrew-sites/sites/pr-7--site_abc/css/style.css",
        "https://acct123.r2.cloudflarestorage.com/sitebrew-sites/sites/pr-7--site_abc/index.html",
      ],
    );
    assert.ok(requests.every((r) => r.method === "DELETE"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("deleteDirectoryFromR2 tolerates a 404 (key already gone) without throwing", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "site-actions-delete-test-"));
  try {
    await writeFile(join(dir, "gone.html"), "bye");
    const fetchImpl = async () => new Response("not found", { status: 404 });

    const result = await deleteDirectoryFromR2({
      directory: dir,
      accountId: "acct123",
      bucket: "sitebrew-sites",
      prefix: "sites/pr-7--site_abc/",
      accessKeyId: "AKID",
      secretAccessKey: "SECRET",
      fetchImpl,
      log: () => {},
    });
    assert.equal(result.deleted, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("deleteDirectoryFromR2 throws with response detail on a real failure", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "site-actions-delete-test-"));
  try {
    await writeFile(join(dir, "index.html"), "hi");
    const fetchImpl = async () => new Response("access denied", { status: 403 });

    await assert.rejects(
      () =>
        deleteDirectoryFromR2({
          directory: dir,
          accountId: "acct123",
          bucket: "sitebrew-sites",
          prefix: "sites/pr-7--site_abc/",
          accessKeyId: "AKID",
          secretAccessKey: "SECRET",
          fetchImpl,
          log: () => {},
        }),
      /answered 403/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
