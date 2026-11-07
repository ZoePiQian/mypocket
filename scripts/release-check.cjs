"use strict";
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const root = path.resolve(__dirname, "..");
const read = name => fs.readFileSync(path.join(root, name));
const json = name => JSON.parse(read(name).toString("utf8"));
const manifest = json("manifest.json"), pkg = json("package.json"), lock = json("package-lock.json");
assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
assert.equal(pkg.version, manifest.version);
assert.equal(lock.version, manifest.version);
assert.equal(lock.packages[""].version, manifest.version);
assert.equal(json("versions.json")[manifest.version], manifest.minAppVersion);
assert.equal(manifest.author, "Zoe Qian");
assert.equal(manifest.id, "local-finance-notes");
assert.match(manifest.description, /\.$/);
assert.ok(manifest.description.length <= 250);
if (process.env.RELEASE_VERSION) {
  assert.equal(process.env.RELEASE_VERSION, manifest.version, "Release tag must match manifest.version");
  if (process.env.GITHUB_ACTIONS === "true") {
    assert.equal(process.env.GITHUB_REF, `refs/tags/${manifest.version}`, "Dispatch the workflow from the release tag");
    const head = require("node:child_process").execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    assert.equal(head, process.env.GITHUB_SHA, "Attestation must identify the checked-out source commit");
  }
}
const files = ["main.js", "manifest.json", "styles.css"];
const output = "安装文件/local-finance-notes";
assert.deepEqual(fs.readdirSync(path.join(root, output)).sort(), [...files].sort());
for (const file of files) {
  const bytes = read(`${output}/${file}`);
  assert.deepEqual(bytes, read(file), `${file} must match the root build output`);
  console.log(`${crypto.createHash("sha256").update(bytes).digest("hex")}  ${file}`);
}
assert.ok(read("main.js").includes(read("LICENSE").toString("utf8").trim()), "Bundle must include the license");
console.log(`Release ${manifest.version}: manifest, lockfile, license and all install files verified.`);
