#!/usr/bin/env node
/**
 * Upload a built Hugo site (`SITE_DIR`) to Cloudflare R2's S3-compatible API,
 * signed with the short-lived credential triple `sitebrew-api`'s
 * `POST /v1/actions/upload-token` minted for this run
 * (`accessKeyId`/`secretAccessKey`/`sessionToken`, scoped to `R2_PREFIX`
 * alone). Zero npm dependencies on purpose: this script runs inside
 * `<site-actions>`'s own reusable workflow, the one place in the whole
 * publish path a customer-repo-triggered run executes code with a live
 * write credential — adding a package here would be a new supply-chain
 * surface for exactly the step ADR-0003 §8's job split exists to keep
 * narrow. AWS SigV4 for a plain object PUT is a self-contained ~100 lines
 * against Node's own `crypto`; see AWS's documented algorithm
 * (docs.aws.amazon.com/general/latest/gr/sigv4-signing-examples.html) —
 * `sitebrew-executor`'s `r2-upload.mjs` reaches for `aws4fetch` instead, but
 * that script runs in a container Anthropic already trusts with far more,
 * not once per push from a workflow a customer's own commits can reach.
 */

import { createHash, createHmac } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const REGION = "auto";
const SERVICE = "s3";

/** `sitebrew-worker`'s own `guessType` (`src/index.js`) — kept identical on purpose. */
const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".xml": "application/xml",
  ".txt": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
  ".webmanifest": "application/manifest+json",
};

export function contentTypeFor(path) {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

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

/** Percent-encode one path segment per SigV4's stricter rules — RFC 3986 unreserved set plus `~`, not encoding `/`. */
function encodeUriSegment(segment) {
  return encodeURIComponent(segment).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodeUriPath(path) {
  return path.split("/").map(encodeUriSegment).join("/");
}

/**
 * The canonical-request / string-to-sign / derived-key steps AWS documents,
 * applied to one fixed PUT — factored out from `putObject` so a test can
 * pin `now` and check the resulting `authorization` header against a frozen
 * reference value, instead of only checking the request went out.
 */
export function signPutRequest({ url, body, contentType, accessKeyId, secretAccessKey, sessionToken, now = new Date() }) {
  const { hostname, pathname } = new URL(url);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = hexHash(body);

  const headers = {
    host: hostname,
    "content-length": String(body.length),
    "content-type": contentType,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...(sessionToken ? { "x-amz-security-token": sessionToken } : {}),
  };
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((h) => `${h}:${headers[h]}\n`).join("");
  const signedHeaders = signedHeaderNames.join(";");

  const canonicalRequest = [
    "PUT",
    encodeUriPath(pathname),
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

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

async function putObject({ url, body, contentType, accessKeyId, secretAccessKey, sessionToken, fetchImpl }) {
  const { headers } = signPutRequest({ url, body, contentType, accessKeyId, secretAccessKey, sessionToken });
  return fetchImpl(url, { method: "PUT", body, headers });
}

/** Upload every file under `directory` to `<prefix><relativePath>` in `bucket`. */
export async function uploadDirectoryToR2({
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
    const body = await readFile(join(directory, path));
    const key = `${prefix}${path}`;
    const url = `${endpoint}/${bucket}/${key}`;
    const response = await putObject({
      url,
      body,
      contentType: contentTypeFor(path),
      accessKeyId,
      secretAccessKey,
      sessionToken,
      fetchImpl,
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`uploading ${key} answered ${response.status}: ${detail.slice(0, 300)}`);
    }
    log(`uploaded ${key}`);
  }

  return { uploaded: files.length };
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

  const result = await uploadDirectoryToR2({
    directory: SITE_DIR,
    accountId: R2_ACCOUNT_ID,
    bucket: R2_BUCKET,
    prefix: R2_PREFIX,
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
    sessionToken: R2_SESSION_TOKEN,
  });
  console.log(`done: ${result.uploaded} file(s) uploaded to ${R2_BUCKET}/${R2_PREFIX}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.stack ?? String(err));
    process.exit(1);
  });
}
