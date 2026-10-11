import { test } from "node:test";
import { strict as assert } from "node:assert";
import { resolveConfig } from "./resolve-sitebrew-config.mjs";

const digest = `sha256:${"a".repeat(64)}`;
const mapping = JSON.stringify({ schemaVersion: 1, releases: { "v1.2.3": digest } });
const config = (builder, build = "npm: false\n  minify: true") =>
  `schemaVersion: 1\nbuilder:\n  ${builder}\nbuild:\n  ${build}\n`;

test("resolves a release and an explicit digest to the same pinned image", () => {
  const expected = { image: `ghcr.io/sitebrewhq/sitebrew-executor@${digest}`, digest, npm: false, minify: true };
  assert.deepEqual(resolveConfig(config("release: v1.2.3"), mapping), expected);
  assert.deepEqual(resolveConfig(config(`image: ghcr.io/sitebrewhq/sitebrew-executor@${digest}`), mapping), expected);
});

test("rejects unknown keys, floating images, missing releases and nonboolean options", () => {
  for (const source of [config("release: v1.2.4"), config("image: ghcr.io/sitebrewhq/sitebrew-executor:latest"),
    config("release: v1.2.3\n  image: ghcr.io/sitebrewhq/sitebrew-executor@" + digest),
    config("release: v1.2.3", "npm: yes\n  minify: true"),
    config("release: v1.2.3", "npm: false\n  minify: true\n  shell: curl"),
    config("release: v1.2.3") + "workflow: evil\n",
    config("release: v1.2.3") + "builder: {release: v1.2.4}\n"]) {
    assert.throws(() => resolveConfig(source, mapping));
  }
});
