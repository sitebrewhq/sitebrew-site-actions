import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const workflow = (name) => parse(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8"));
const { jobs } = workflow("sitebrew");
const legacy = workflow("build").jobs;
const step = (job, name) => job.steps.find((entry) => entry.name === name);

for (const [job, name] of [
  ["build", "Build in the recorded image"],
  ["cleanup-build", "Build deletion list in the recorded image"],
]) {
  test(`${job} runs the container build script with Bash`, () => {
    assert.ok(jobs[job].container);
    assert.equal(step(jobs[job], name).shell, "bash");
  });
}

test("closed-PR cleanup emits main's SHA-256 job output without a cache write", () => {
  const build = jobs["cleanup-build"];
  assert.deepEqual(build.outputs, legacy["cleanup-build"].outputs);
  assert.ok(!build.steps.some((entry) => entry.uses?.startsWith("actions/cache/")));
  // This step also runs inside the builder container, whose default shell is sh.
  assert.deepEqual(step(build, "Emit build file list"), {
    ...step(legacy["cleanup-build"], "Emit build file list"), shell: "bash",
  });
});

for (const [job, name] of [
  ["cleanup-build", "Upload build file list"],
  ["cleanup", "Download build file list"],
]) {
  test(`${job}: ${name} exactly matches main's artifact action and settings`, () => {
    assert.ok(step(jobs[job], name));
    assert.deepEqual(step(jobs[job], name), step(legacy[job], name));
  });
}

test("every opt-in action and pin is already used by main's build workflow", () => {
  const allowed = new Set(Object.values(legacy).flatMap((job) => job.steps.map((entry) => entry.uses).filter(Boolean)));
  for (const job of Object.values(jobs)) {
    for (const entry of job.steps) {
      if (entry.uses) assert.ok(allowed.has(entry.uses), `unexpected action or pin: ${entry.uses}`);
    }
  }
});

test("cleanup materialises main's file-list handoff without a cache restore", () => {
  assert.equal(jobs.cleanup.needs, "cleanup-build");
  assert.deepEqual(step(jobs.cleanup, "Materialise build file list"), step(legacy.cleanup, "Materialise build file list"));
  assert.ok(step(jobs.cleanup, "Materialise build file list"));
  assert.ok(!jobs.cleanup.steps.some((entry) => entry.uses?.startsWith("actions/cache/")));
});

test("cleanup deletes using main's FILE_LIST handoff", () => {
  assert.deepEqual(step(jobs.cleanup, "Delete preview from R2"), step(legacy.cleanup, "Delete preview from R2"));
});

for (const [job, mint, callback] of [
  ["deploy", "Mint R2 upload credential", "Record preview hostname"],
  ["cleanup", "Mint R2 delete credential", "Remove preview hostname"],
]) {
  test(`${job} checks out the reviewed scripts after OIDC and before minting credentials`, () => {
    const steps = jobs[job].steps;
    const index = (name) => steps.findIndex((entry) => entry.name === name);
    const resolve = "Resolve this reusable workflow's own repository and ref";
    const checkout = "Checkout sitebrew-site-actions (scripts)";
    assert.ok(index("Request GitHub OIDC token") < index(resolve));
    assert.ok(index(resolve) < index(checkout));
    assert.ok(index(checkout) < index(mint), "reviewed scripts must be available before minting");
    assert.deepEqual(step(jobs[job], resolve), step(legacy[job], resolve));
    assert.deepEqual(step(jobs[job], checkout), step(legacy[job], checkout));
  });

  for (const name of [mint, callback]) {
    test(`${job}: ${name} uses main's sitebrew-api-call.mjs retry wrapper`, () => {
      const actual = step(jobs[job], name);
      assert.match(actual.run, /node \.site-actions\/scripts\/sitebrew-api-call\.mjs/);
      assert.deepEqual(actual, step(legacy[job], name));
    });
  }
}
