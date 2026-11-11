import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const workflow = readFileSync(new URL("../.github/workflows/build.yml", import.meta.url), "utf8");

function job(name) {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `missing job: ${name}`);
  return workflow.slice(start + 1).split(/\n(?=  [\w-]+:\n)/)[0];
}

function step(jobText, name) {
  const found = jobText.split(/(?=^      - name: )/m)
    .find((block) => block.startsWith(`      - name: ${name}\n`));
  assert.ok(found, `missing step: ${name}`);
  return found;
}

function script(stepText) {
  const found = stepText.match(/^        run: \|\n((?:          [^\n]*\n|\n)+)/m);
  assert.ok(found, "step must have an inline shell script");
  return found[1].replace(/^          /gm, "");
}

function run(scriptText, cwd, runnerTemp, output) {
  return spawnSync("bash", ["-e", "-o", "pipefail", "-c", scriptText], {
    cwd,
    env: { ...process.env, RUNNER_TEMP: runnerTemp, GITHUB_OUTPUT: output },
    encoding: "utf8",
  });
}

const producer = job("cleanup-build");
const consumer = job("cleanup");

test("cleanup file list never travels in job outputs, an environment variable, or an inline expression", () => {
  assert.doesNotMatch(producer, /^    outputs:/m);
  assert.doesNotMatch(step(producer, "Emit build file list"), /GITHUB_OUTPUT|base64|encoded/);
  assert.doesNotMatch(consumer, /FILES_B64|needs\.cleanup-build\.outputs/);
  assert.doesNotMatch(step(consumer, "Materialise build file list"), /base64|\$\{\{/);
});

test("cleanup file-list artifact uses pinned actions, one-day retention, and a required exact file", () => {
  const upload = step(producer, "Upload build file list");
  const download = step(consumer, "Download build file list");
  assert.match(upload, /uses: actions\/upload-artifact@[a-f0-9]{40}\b/);
  assert.match(download, /uses: actions\/download-artifact@[a-f0-9]{40}\b/);
  const artifactName = /^          name: (.+)$/m;
  assert.equal(upload.match(artifactName)?.[1], "cleanup-files-${{ github.run_id }}");
  assert.equal(download.match(artifactName)?.[1], upload.match(artifactName)?.[1]);
  assert.match(upload, /^          path: \$\{\{ runner.temp \}\}\/cleanup-files.txt$/m);
  assert.match(upload, /^          retention-days: 1$/m);
  assert.match(upload, /^          if-no-files-found: error$/m);
  assert.match(upload, /^          overwrite: true$/m, "re-running cleanup-build must replace its artifact");
  assert.match(download, /^          path: \$\{\{ runner.temp \}\}\/cleanup-file-list$/m);
  assert.doesNotMatch(upload + download, /continue-on-error:|^        if:|github-token:|run-id:/m);
});

test("cleanup validates the downloaded file before minting credentials and still keeps builds credential-free", () => {
  assert.match(consumer, /^    needs: cleanup-build$/m);
  assert.doesNotMatch(producer, /id-token:/);
  assert.match(consumer, /^      id-token: write$/m);
  assert.ok(producer.indexOf("- name: Emit build file list") < producer.indexOf("- name: Upload build file list"));
  assert.ok(consumer.indexOf("- name: Download build file list") < consumer.indexOf("- name: Materialise build file list"));
  assert.ok(consumer.indexOf("- name: Materialise build file list") < consumer.indexOf("- name: Request GitHub OIDC token"));
  assert.match(step(consumer, "Delete preview from R2"), /^          FILE_LIST: \$\{\{ runner.temp \}\}\/cleanup-file-list\/cleanup-files.txt$/m);
});

test("a missing downloaded file fails loudly before cleanup, rather than acting like an empty build", () => {
  const dir = mkdtempSync(join(tmpdir(), "cleanup-list-missing-"));
  try {
    const result = run(script(step(consumer, "Materialise build file list")), dir, dir, join(dir, "output"));
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout + result.stderr, /::error::.*[Ff]ile list.*missing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Execute the workflow's actual shell blocks, simulating only the artifact
// service's file copy. Hashed names resist compression, as real Hugo assets do.
for (const count of [0, 5000, 20000]) {
  test(`artifact handoff preserves all ${count} filenames across the former capacity limits`, () => {
    const dir = mkdtempSync(join(tmpdir(), "cleanup-list-capacity-"));
    try {
      const buildTemp = join(dir, "build-temp");
      const cleanupTemp = join(dir, "cleanup-temp");
      mkdirSync(join(dir, "public", "assets"), { recursive: true });
      mkdirSync(buildTemp);
      mkdirSync(join(cleanupTemp, "cleanup-file-list"), { recursive: true });
      const paths = Array.from({ length: count }, (_, i) =>
        `assets/${createHash("sha256").update(String(i)).digest("hex")}.css`);
      for (const path of paths) writeFileSync(join(dir, "public", path), "");
      const expected = paths.length ? `${paths.sort().join("\n")}\n` : "";
      const encodedLength = gzipSync(expected).toString("base64").length;
      if (count >= 5000) assert.ok(encodedLength > 128 * 1024, "fixture must exceed a single Linux env string");
      if (count === 20000) {
        assert.ok(encodedLength * 2 > 1024 * 1024, "fixture must exceed the UTF-16 job-output budget");
        assert.ok(encodedLength > 900000, "fixture must exceed the old producer guard too");
      }

      const output = join(dir, "output");
      writeFileSync(output, "");
      const emitted = run(script(step(producer, "Emit build file list")), dir, buildTemp, output);
      assert.equal(emitted.status, 0, emitted.stdout + emitted.stderr);
      assert.equal(readFileSync(output, "utf8"), "", "file-list payload must never enter step/job outputs");
      const source = join(buildTemp, "cleanup-files.txt");
      assert.equal(readFileSync(source, "utf8"), expected);

      const destination = join(cleanupTemp, "cleanup-file-list", "cleanup-files.txt");
      copyFileSync(source, destination);
      const received = run(script(step(consumer, "Materialise build file list")), dir, cleanupTemp, output);
      assert.equal(received.status, 0, received.stdout + received.stderr);
      assert.match(received.stdout, new RegExp(`\\b${count} file\\(s\\) to delete`));
      assert.equal(readFileSync(destination, "utf8"), expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
