import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

for (const workflowName of ["build", "sitebrew"]) {
  describe(`${workflowName}.yml cleanup`, () => {
    const workflow = readFileSync(new URL(`../.github/workflows/${workflowName}.yml`, import.meta.url), "utf8");

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

    function run(scriptText, cwd, runnerTemp, output, env = {}) {
      return spawnSync("bash", ["-e", "-o", "pipefail", "-c", scriptText], {
        cwd,
        env: { ...process.env, RUNNER_TEMP: runnerTemp, GITHUB_OUTPUT: output, ...env },
        encoding: "utf8",
      });
    }

    const producer = job("cleanup-build");
    const consumer = job("cleanup");

    test("cleanup file list never travels in job outputs, an environment variable, or an inline expression", () => {
      assert.equal(producer.match(/^    outputs:\n((?:      .+\n)+)/m)?.[1],
        "      file-list-sha256: ${{ steps.file-list.outputs.sha256 }}\n");
      assert.match(step(producer, "Emit build file list"), /^        id: file-list$/m);
      assert.doesNotMatch(step(producer, "Emit build file list"), /base64|encoded/);
      assert.doesNotMatch(consumer, /FILES_B64/);
      const validation = step(consumer, "Materialise build file list");
      assert.match(validation, /^          EXPECTED_SHA256: \$\{\{ needs\.cleanup-build\.outputs\.file-list-sha256 \}\}$/m);
      assert.doesNotMatch(script(validation), /base64|\$\{\{/);
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
      assert.ok(consumer.indexOf("- name: Materialise build file list") < consumer.indexOf("- name: Mint R2 delete credential"));
      assert.doesNotMatch(step(consumer, "Materialise build file list"), /continue-on-error:|^        if:/m);
      assert.match(step(consumer, "Delete preview from R2"), /^          FILE_LIST: \$\{\{ runner.temp \}\}\/cleanup-file-list\/cleanup-files.txt$/m);
    });

    for (const [name, downloaded] of [
      ["corrupted", "assets/six.css\nassets/two.css\n"],
      ["truncated", "assets/one.css\n"],
      ["fully truncated", ""],
    ]) {
      test(`cleanup rejects a ${name} file list before the credential step`, () => {
        const dir = mkdtempSync(join(tmpdir(), "cleanup-list-integrity-"));
        try {
          mkdirSync(join(dir, "cleanup-file-list"));
          writeFileSync(join(dir, "cleanup-file-list", "cleanup-files.txt"), downloaded);
          const expectedHash = createHash("sha256").update("assets/one.css\nassets/two.css\n").digest("hex");
          const result = run(`${script(step(consumer, "Materialise build file list"))}\necho reached > credential-step`,
            dir, dir, join(dir, "output"), { EXPECTED_SHA256: expectedHash });
          assert.equal(result.status, 1, result.stdout + result.stderr);
          assert.match(result.stdout + result.stderr, /::error::.*SHA-256.*mismatch/);
          assert.equal(existsSync(join(dir, "credential-step")), false, "credentials must not be requested after validation fails");
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    }

    for (const hash of [undefined, "", "not-a-sha256"]) {
      test(`cleanup rejects a ${hash === undefined ? "missing" : hash === "" ? "empty" : "malformed"} expected hash before the credential step`, () => {
        const dir = mkdtempSync(join(tmpdir(), "cleanup-list-hash-"));
        try {
          mkdirSync(join(dir, "cleanup-file-list"));
          writeFileSync(join(dir, "cleanup-file-list", "cleanup-files.txt"), "");
          const result = run(`${script(step(consumer, "Materialise build file list"))}\necho reached > credential-step`,
            dir, dir, join(dir, "output"), { EXPECTED_SHA256: hash });
          assert.equal(result.status, 1, result.stdout + result.stderr);
          assert.match(result.stdout + result.stderr, /::error::.*SHA-256.*missing or invalid/);
          assert.equal(existsSync(join(dir, "credential-step")), false);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    }

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
          const expectedHash = createHash("sha256").update(expected).digest("hex");
          assert.equal(readFileSync(output, "utf8"), `sha256=${expectedHash}\n`, "only a tiny hex digest may enter step/job outputs");
          const source = join(buildTemp, "cleanup-files.txt");
          assert.equal(readFileSync(source, "utf8"), expected);

          const destination = join(cleanupTemp, "cleanup-file-list", "cleanup-files.txt");
          copyFileSync(source, destination);
          const received = run(script(step(consumer, "Materialise build file list")), dir, cleanupTemp, output,
            { EXPECTED_SHA256: readFileSync(output, "utf8").trim().split("=")[1] });
          assert.equal(received.status, 0, received.stdout + received.stderr);
          assert.match(received.stdout, new RegExp(`\\b${count} file\\(s\\) to delete`));
          assert.equal(readFileSync(destination, "utf8"), expected);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    }
  });
}
