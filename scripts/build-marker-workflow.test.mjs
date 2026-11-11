import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = fileURLToPath(new URL("../", import.meta.url));
const sourceCommit = "a".repeat(40);
const imageDigest = `sha256:${"b".repeat(64)}`;

for (const name of ["build", "sitebrew"]) {
  const workflow = parse(readFileSync(join(root, ".github/workflows", `${name}.yml`), "utf8"));
  const upload = workflow.jobs.deploy.steps.find((step) => step.name === "Upload site to R2");

  test(`${name}: build-marker defaults to false and reaches the uploader`, () => {
    assert.equal(workflow.on.workflow_call.inputs["build-marker"]?.type, "boolean");
    assert.equal(workflow.on.workflow_call.inputs["build-marker"]?.default, false);
    assert.equal(upload.env.BUILD_MARKER_ENABLED, "${{ inputs.build-marker }}");
  });

  for (const { enabled, tamper = false } of [{}, { enabled: false }, { enabled: true }, { enabled: true, tamper: true }]) {
    for (const existing of [false, true]) {
      test(`${name}: actual upload command, marker=${enabled ?? "default"}, existing=${existing}, tamper=${tamper}`, () => {
        const dir = mkdtempSync(join(tmpdir(), "build-marker-workflow-"));
        try {
          mkdirSync(join(dir, "public"));
          writeFileSync(join(dir, "public", "index.html"), "legacy site\n");
          const markerPath = join(dir, "public", ".sitebrew", "build.json");
          if (existing) {
            mkdirSync(join(dir, "public", ".sitebrew"));
            writeFileSync(markerPath, "site-owned marker, not workflow JSON\n");
          }
          mkdirSync(join(dir, ".site-actions", "scripts"), { recursive: true });
          copyFileSync(join(root, "scripts", "upload-to-r2.mjs"), join(dir, ".site-actions", "scripts", "upload-to-r2.mjs"));
          // Run the workflow command and real CLI, replacing only the R2 transport.
          const transport = join(dir, "transport.mjs");
          writeFileSync(transport, `
            import { appendFileSync } from "node:fs";
            import fs from "node:fs/promises";
            import { syncBuiltinESMExports } from "node:module";
            if (${tamper}) {
              const readFile = fs.readFile;
              fs.readFile = async (path, ...args) => String(path).endsWith("/.sitebrew/build.json")
                ? Buffer.from("tampered\\n") : readFile(path, ...args);
              syncBuiltinESMExports();
            }
            globalThis.fetch = async (url, options) => {
              appendFileSync("uploaded.jsonl", JSON.stringify({ url, body: options.body.toString("base64") }) + "\\n");
              return { ok: true };
            };
          `);
          const values = {
            "inputs.build-marker": enabled ?? workflow.on.workflow_call.inputs["build-marker"]?.default,
            "github.sha": sourceCommit,
            "needs.resolve.outputs.digest": imageDigest,
            "steps.mint.outputs.accountId": "acct123",
            "steps.mint.outputs.bucket": "sitebrew-sites",
            "steps.mint.outputs.prefix": "sites/x/",
            "steps.mint.outputs.accessKeyId": "AKID",
            "steps.mint.outputs.secretAccessKey": "SECRET",
            "steps.mint.outputs.sessionToken": "SESSION",
          };
          const env = { ...process.env, NODE_OPTIONS: `--import=${transport}` };
          delete env.BUILD_MARKER_ENABLED;
          for (const [key, value] of Object.entries(upload.env)) {
            env[key] = value.replace(/\$\{\{ (.*?) \}\}/g, (_, expression) => String(values[expression] ?? ""));
          }
          if (!enabled) {
            // Opted-out callers must not require or validate marker metadata either.
            env.EXPECTED_SOURCE_COMMIT = "invalid SHA";
            env.EXPECTED_IMAGE_DIGEST = "invalid digest";
          }
          const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", upload.run], { cwd: dir, env, encoding: "utf8" });
          if (tamper) {
            assert.equal(result.status, 1, result.stdout + result.stderr);
            assert.match(result.stderr, /build marker does not match workflow values/);
            assert.equal(existsSync(join(dir, "uploaded.jsonl")), false, "reject altered marker bytes before any R2 request");
            return;
          }
          assert.equal(result.status, 0, result.stdout + result.stderr);
          const uploaded = readFileSync(join(dir, "uploaded.jsonl"), "utf8").trim().split("\n")
            .map((line) => JSON.parse(line))
            .map(({ url, body }) => [new URL(url).pathname.replace("/sitebrew-sites/sites/x/", ""), Buffer.from(body, "base64").toString()])
            .sort(([a], [b]) => a.localeCompare(b));
          const expected = [["index.html", "legacy site\n"]];
          if (enabled || existing) {
            const marker = enabled
              ? JSON.stringify({ sourceCommit, imageDigest: name === "sitebrew" ? imageDigest : null }) + "\n"
              : "site-owned marker, not workflow JSON\n";
            expected.unshift([".sitebrew/build.json", marker]);
            assert.equal(readFileSync(markerPath, "utf8"), marker);
          } else {
            assert.equal(existsSync(join(dir, "public", ".sitebrew")), false);
          }
          assert.deepEqual(uploaded, expected, "legacy keys and bytes must be preserved unless explicitly opted in");
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    }
  }
}
