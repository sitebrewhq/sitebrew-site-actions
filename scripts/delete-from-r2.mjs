#!/usr/bin/env node
/**
 * Delete a pull-request preview's objects from Cloudflare R2's S3-compatible
 * API, signed with the same short-lived credential triple `upload-to-r2.mjs`
 * uses (`POST /v1/actions/upload-token` is scoped to `object-read-write`,
 * which covers `DeleteObject` too — same mint call the deploy job makes).
 *
 * Deliberately **not** a `ListObjectsV2` + delete-what's-there approach: that
 * needs SigV4's query-string canonicalization (a second, more complex
 * signing path) for a case this script does not need it for. A pull-request
 * preview's R2 content is always exactly last successful deploy's Hugo
 * build output — nothing else is ever written under its prefix — so
 * rebuilding that same commit and deleting the resulting file list is byte-
 * for-byte the same key set `ListObjectsV2` would answer, without a second
 * signing path or the extra round trip. Kept as its own file rather than
 * added to `upload-to-r2.mjs` so that script's frozen reference-signature
 * test (`upload-to-r2.test.mjs`) stays untouched by an unrelated change.
 */

import { createHash, createHmac } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const REGION = "auto";
const SERVICE = "s3";

export async function listFiles(directory) {
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) files.push(...(await walk(full)));
      else if (entry.isFile()) files.push(relative(directory, full));
    }
    return files;
  }
  return (await walk(directory)).sort();
}

function hexHash(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function hmac(key, value) {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

function signingKey({ secretAccessKey, dateStamp, region, service }) {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

function encodeUriSegment(segment) {
  return encodeURIComponent(segment).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodeUriPath(path) {
  return path.split("/").map(encodeUriSegment).join("/");
}

/** Same shape as `upload-to-r2.mjs`'s `signPutRequest`, for a bodyless `DELETE` instead of a `PUT`. */
export function signDeleteRequest({ url, accessKeyId, secretAccessKey, sessionToken, now = new Date() }) {
  const { hostname, pathname } = new URL(url);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = hexHash(Buffer.alloc(0));

  const headers = {
    host: hostname,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...(sessionToken ? { "x-amz-security-token": sessionToken } : {}),
  };
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((h) => `${h}:${headers[h]}\n`).join("");
  const signedHeaders = signedHeaderNames.join(";");

  const canonicalRequest = ["DELETE", encodeUriPath(pathname), "", canonicalHeaders, signedHeaders, payloadHash].join(
    "\n",
  );

  const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    hexHash(Buffer.from(canonicalRequest, "utf8")),
  ].join("\n");

  const key = signingKey({ secretAccessKey, dateStamp, region: REGION, service: SERVICE });
  const signature = createHmac("sha256", key).update(stringToSign, "utf8").digest("hex");

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { headers: { ...headers, authorization } };
}

async function deleteObject({ url, accessKeyId, secretAccessKey, sessionToken, fetchImpl }) {
  const { headers } = signDeleteRequest({ url, accessKeyId, secretAccessKey, sessionToken });
  return fetchImpl(url, { method: "DELETE", headers });
}

/**
 * Delete `<prefix><relativePath>` for every file under `directory` — the
 * exact key set `upload-to-r2.mjs`'s `uploadDirectoryToR2` would have
 * written for the same directory and prefix, so a rebuild of the closed
 * PR's last commit reconstructs precisely what needs removing.
 *
 * A `DELETE` on a key that never existed (a rebuild that produced one file
 * fewer than the original deploy did — a page removed in a later commit,
 * say) answers `204` from S3-compatible APIs the same as a real delete, so
 * this does not need to distinguish the two cases to be correct: every key
 * this run's rebuild names is gone afterward either way.
 */
export async function deleteDirectoryFromR2({
  directory,
  accountId,
  bucket,
  prefix,
  accessKeyId,
  secretAccessKey,
  sessionToken,
  fetchImpl = fetch,
  log = console.log,
}) {
  const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
  const files = await listFiles(directory);

  for (const path of files) {
    const key = `${prefix}${path}`;
    const url = `${endpoint}/${bucket}/${key}`;
    const response = await deleteObject({ url, accessKeyId, secretAccessKey, sessionToken, fetchImpl });
    if (!response.ok && response.status !== 404) {
      const detail = await response.text();
      throw new Error(`deleting ${key} answered ${response.status}: ${detail.slice(0, 300)}`);
    }
    log(`deleted ${key}`);
  }

  return { deleted: files.length };
}

async function main() {
  const {
    R2_ACCOUNT_ID,
    R2_BUCKET,
    R2_PREFIX,
    R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY,
    R2_SESSION_TOKEN,
    SITE_DIR = "public",
  } = process.env;

  for (const [name, value] of Object.entries({
    R2_ACCOUNT_ID,
    R2_BUCKET,
    R2_PREFIX,
    R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY,
    R2_SESSION_TOKEN,
  })) {
    if (!value) throw new Error(`missing required env var ${name}`);
  }

  const result = await deleteDirectoryFromR2({
    directory: SITE_DIR,
    accountId: R2_ACCOUNT_ID,
    bucket: R2_BUCKET,
    prefix: R2_PREFIX,
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
    sessionToken: R2_SESSION_TOKEN,
  });
  console.log(`done: ${result.deleted} file(s) deleted from ${R2_BUCKET}/${R2_PREFIX}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.stack ?? String(err));
    process.exit(1);
  });
}
