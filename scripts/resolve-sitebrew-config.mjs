import { readFileSync, appendFileSync } from "node:fs";
import YAML from "yaml";

const IMAGE = "ghcr.io/sitebrewhq/sitebrew-executor";
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const RELEASE = /^v\d+\.\d+\.\d+$/;
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).every((key) => keys.includes(key));

export function resolveConfig(source, mappingSource) {
  const document = YAML.parseDocument(source, { uniqueKeys: true, merge: false });
  if (document.errors.length) throw new Error(`invalid sitebrew.yaml: ${document.errors[0].message}`);
  const config = document.toJS();
  if (!exact(config, ["schemaVersion", "builder", "build"]) || config.schemaVersion !== 1 ||
      !exact(config.builder, ["image", "release"]) ||
      !exact(config.build, ["npm", "minify"]) ||
      typeof config.build.npm !== "boolean" || typeof config.build.minify !== "boolean") {
    throw new Error("sitebrew.yaml must use only the approved v1 keys and boolean build options");
  }
  if (Object.keys(config.builder).length !== 1) throw new Error("choose exactly one builder image or release");
  const mapping = JSON.parse(mappingSource);
  if (!exact(mapping, ["schemaVersion", "releases"]) || mapping.schemaVersion !== 1 ||
      !exact(mapping.releases, Object.keys(mapping.releases))) throw new Error("invalid builder image mapping");
  for (const [release, digest] of Object.entries(mapping.releases)) {
    if (!RELEASE.test(release) || typeof digest !== "string" || !DIGEST.test(digest)) throw new Error("invalid release mapping entry");
  }
  let digest;
  if ("image" in config.builder) {
    const image = config.builder.image;
    if (typeof image !== "string" || !image.startsWith(`${IMAGE}@`)) throw new Error("builder image must name the platform GHCR repository");
    digest = image.slice(IMAGE.length + 1);
  } else {
    const release = config.builder.release;
    if (typeof release !== "string" || !RELEASE.test(release) || !mapping.releases[release]) throw new Error("unrecorded platform release");
    digest = mapping.releases[release];
  }
  if (!DIGEST.test(digest)) throw new Error("builder image must use a sha256 digest");
  if (!Object.values(mapping.releases).includes(digest)) throw new Error("builder digest is not a recorded release");
  return { image: `${IMAGE}@${digest}`, digest, npm: config.build.npm, minify: config.build.minify };
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const [configPath, mappingPath] = process.argv.slice(2);
  const result = resolveConfig(readFileSync(configPath, "utf8"), readFileSync(mappingPath, "utf8"));
  for (const [key, value] of Object.entries(result)) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}
