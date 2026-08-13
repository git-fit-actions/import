"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const {
  EMPTY_TREE_HASH,
  ValidationError,
  compareChecksums,
  computeTreeHashFromLS,
  generateSHA256SUMS,
  isZipArchive,
  listDataFiles,
  parseSources,
  readImportMarker,
  resolveConfig,
  writeImportMarker,
} = require("../dist/shared.cjs");

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "git-fit-import-test-"));
}

function writeTree(base, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(base, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

// ── parseSources ──

test("parseSources: comma-separated list", () => {
  assert.deepEqual(parseSources("apple_health,2bulu"), ["apple_health", "2bulu"]);
});

test("parseSources: gpx,fit,tcx sources accepted", () => {
  assert.deepEqual(parseSources("gpx,fit,tcx"), ["gpx", "fit", "tcx"]);
});

test("parseSources: all five sources mixed separators", () => {
  assert.deepEqual(parseSources("apple_health, 2bulu\ngpx,fit,tcx"), [
    "apple_health",
    "2bulu",
    "gpx",
    "fit",
    "tcx",
  ]);
});

test("parseSources: newline-separated list", () => {
  assert.deepEqual(parseSources("apple_health\n2bulu"), ["apple_health", "2bulu"]);
});

test("parseSources: mixed separators with spaces", () => {
  assert.deepEqual(parseSources("apple_health, 2bulu\n"), ["apple_health", "2bulu"]);
});

test("parseSources: dedups preserving first-occurrence order", () => {
  assert.deepEqual(parseSources("2bulu,2bulu,apple_health"), ["2bulu", "apple_health"]);
});

test("parseSources: filters empty items", () => {
  assert.deepEqual(parseSources(",\napple_health,\n"), ["apple_health"]);
});

test("parseSources: unknown source fails with actionable message", () => {
  assert.throws(() => parseSources("foo"), ValidationError);
  assert.throws(
    () => parseSources("foo"),
    /Unknown source 'foo'.*Supported: apple_health, 2bulu, gpx, fit, tcx.*Fix:/
  );
});

test("parseSources: multiple unknown sources reported together", () => {
  assert.throws(() => parseSources("foo,bar"), /Unknown source 'foo'.*Unknown source 'bar'/);
});

test("parseSources: valid + unknown mixed fails", () => {
  assert.throws(() => parseSources("apple_health,foo"), /Unknown source 'foo'/);
});

test("parseSources: whitespace-only input rejected", () => {
  assert.throws(() => parseSources("  \n,"), /No valid sources/);
});

test("parseSources: empty string rejected", () => {
  assert.throws(() => parseSources(""), /No valid sources/);
});

// ── resolveConfig ──

test("resolveConfig: apple_health defaults", () => {
  const cfg = resolveConfig("apple_health", {});
  assert.equal(cfg.branch, "GitFit/import/apple_health");
  assert.equal(cfg.dir, "data/import/apple_health");
  assert.equal(cfg.remote, "origin/GitFit/import/apple_health");
  assert.equal(cfg.cacheKeyPrefix, "import-apple_health-v0-marker");
  assert.equal(cfg.importCmd, "apple_health");
  assert.equal(cfg.title, "Apple Health");
  assert.equal(cfg.validateFile, "export.zip");
});

test("resolveConfig: 2bulu maps to tbulu import cmd", () => {
  const cfg = resolveConfig("2bulu", {});
  assert.equal(cfg.branch, "GitFit/import/2bulu");
  assert.equal(cfg.dir, "data/import/2bulu");
  assert.equal(cfg.cacheKeyPrefix, "import-2bulu-v0-marker");
  assert.equal(cfg.importCmd, "tbulu");
  assert.equal(cfg.validateFile, undefined);
});

test("resolveConfig: gpx defaults", () => {
  const cfg = resolveConfig("gpx", {});
  assert.equal(cfg.branch, "GitFit/import/gpx");
  assert.equal(cfg.dir, "data/import/gpx");
  assert.equal(cfg.remote, "origin/GitFit/import/gpx");
  assert.equal(cfg.cacheKeyPrefix, "import-gpx-v0-marker");
  assert.equal(cfg.importCmd, "gpx");
  assert.equal(cfg.title, "GPX");
  assert.equal(cfg.validateFile, undefined);
});

test("resolveConfig: fit defaults", () => {
  const cfg = resolveConfig("fit", {});
  assert.equal(cfg.branch, "GitFit/import/fit");
  assert.equal(cfg.dir, "data/import/fit");
  assert.equal(cfg.cacheKeyPrefix, "import-fit-v0-marker");
  assert.equal(cfg.importCmd, "fit");
  assert.equal(cfg.validateFile, undefined);
});

test("resolveConfig: tcx defaults", () => {
  const cfg = resolveConfig("tcx", {});
  assert.equal(cfg.branch, "GitFit/import/tcx");
  assert.equal(cfg.dir, "data/import/tcx");
  assert.equal(cfg.cacheKeyPrefix, "import-tcx-v0-marker");
  assert.equal(cfg.importCmd, "tcx");
  assert.equal(cfg.validateFile, undefined);
});

test("resolveConfig: gpx overrides applied, defaults kept", () => {
  const cfg = resolveConfig("gpx", { branch: "x", cacheKey: "y" });
  assert.equal(cfg.branch, "x");
  assert.equal(cfg.cacheKeyPrefix, "y");
  assert.equal(cfg.dir, "data/import/gpx");
  assert.equal(cfg.remote, "origin/x");
  assert.equal(cfg.importCmd, "gpx");
  assert.equal(cfg.title, "GPX");
});

test("resolveConfig: overrides applied, untouched defaults kept", () => {
  const cfg = resolveConfig("apple_health", { branch: "x", cacheKey: "y" });
  assert.equal(cfg.branch, "x");
  assert.equal(cfg.cacheKeyPrefix, "y");
  assert.equal(cfg.dir, "data/import/apple_health");
  assert.equal(cfg.remote, "origin/x");
});

test("resolveConfig: {source} placeholder expands in branch override", () => {
  const cfg = resolveConfig("gpx", { branch: "GitFit/import/dev-{source}" });
  assert.equal(cfg.branch, "GitFit/import/dev-gpx");
  assert.equal(cfg.remote, "origin/GitFit/import/dev-gpx");
  assert.equal(cfg.dir, "data/import/gpx");
});

test("resolveConfig: {source} placeholder expands in cache-key override", () => {
  const cfg = resolveConfig("fit", { cacheKey: "import-{source}-v1" });
  assert.equal(cfg.cacheKeyPrefix, "import-fit-v1");
  assert.equal(cfg.branch, "GitFit/import/fit");
});

test("resolveConfig: literal branch override (no placeholder) kept verbatim", () => {
  const cfg = resolveConfig("gpx", { branch: "GitFit/import/mirror" });
  assert.equal(cfg.branch, "GitFit/import/mirror");
  assert.equal(cfg.remote, "origin/GitFit/import/mirror");
  assert.equal(cfg.dir, "data/import/gpx");
});

test("resolveConfig: multi-source monorepo layout keeps per-source dirs", () => {
  const gpx = resolveConfig("gpx", { branch: "GitFit/import/all" });
  const fit = resolveConfig("fit", { branch: "GitFit/import/all" });
  assert.equal(gpx.branch, "GitFit/import/all");
  assert.equal(gpx.dir, "data/import/gpx");
  assert.equal(fit.dir, "data/import/fit");
  assert.equal(gpx.cacheKeyPrefix, "import-gpx-v0-marker");
  assert.equal(fit.cacheKeyPrefix, "import-fit-v0-marker");
});

test("resolveConfig: unknown source throws", () => {
  assert.throws(() => resolveConfig("foo", {}), /Unknown source 'foo'/);
});

// ── computeTreeHashFromLS ──

const S1 = "1111111111111111111111111111111111111111";
const S2 = "2222222222222222222222222222222222222222";
const S3 = "3333333333333333333333333333333333333333";
const S4 = "4444444444444444444444444444444444444444";

test("computeTreeHashFromLS: hashes blob SHAs of all entries", () => {
  const ls = [
    `100644 blob ${S1}\tdata/import/2bulu/a.2tk`,
    `100644 blob ${S2}\tdata/import/2bulu/sub/b.kml`,
  ].join("\n") + "\n";
  const expected = crypto
    .createHash("sha256")
    .update(`${S1}\n${S2}\n`)
    .digest("hex");
  assert.equal(computeTreeHashFromLS(ls), expected);
});

test("computeTreeHashFromLS: excludes SHA256SUMS", () => {
  const ls = [
    `100644 blob ${S1}\tdata/import/2bulu/a.2tk`,
    `100644 blob ${S3}\tdata/import/2bulu/SHA256SUMS`,
  ].join("\n") + "\n";
  const expected = crypto
    .createHash("sha256")
    .update(`${S1}\n`)
    .digest("hex");
  assert.equal(computeTreeHashFromLS(ls), expected);
});

test("computeTreeHashFromLS: excludes .import-marker", () => {
  const ls = [
    `100644 blob ${S1}\tdata/import/2bulu/a.2tk`,
    `100644 blob ${S4}\tdata/import/2bulu/.import-marker`,
  ].join("\n") + "\n";
  const expected = crypto
    .createHash("sha256")
    .update(`${S1}\n`)
    .digest("hex");
  assert.equal(computeTreeHashFromLS(ls), expected);
});

test("computeTreeHashFromLS: only markers → EMPTY_TREE_HASH", () => {
  const ls = [
    `100644 blob ${S3}\tdata/import/2bulu/SHA256SUMS`,
    `100644 blob ${S4}\tdata/import/2bulu/.import-marker`,
  ].join("\n") + "\n";
  assert.equal(computeTreeHashFromLS(ls), EMPTY_TREE_HASH);
});

test("computeTreeHashFromLS: empty input → EMPTY_TREE_HASH", () => {
  assert.equal(computeTreeHashFromLS(""), EMPTY_TREE_HASH);
  assert.equal(computeTreeHashFromLS("\n\n"), EMPTY_TREE_HASH);
});

test("computeTreeHashFromLS: paths with spaces still hash the SHA", () => {
  const ls = `100644 blob ${S1}\tdata/import/2bulu/a file.2tk\n`;
  const expected = crypto
    .createHash("sha256")
    .update(`${S1}\n`)
    .digest("hex");
  assert.equal(computeTreeHashFromLS(ls), expected);
});

test("EMPTY_TREE_HASH equals sha256 of empty input", () => {
  assert.equal(
    EMPTY_TREE_HASH,
    crypto.createHash("sha256").update("").digest("hex")
  );
});

// ── generateSHA256SUMS / compareChecksums ──

test("generateSHA256SUMS: byte-identical to bash pipeline, passes sha256sum --check", () => {
  const dir = tmpdir();
  writeTree(dir, { "a.txt": "hello\n", "sub/b .txt": "world\n" });
  generateSHA256SUMS(dir);
  const generated = fs.readFileSync(path.join(dir, "SHA256SUMS"), "utf8");
  const bashOutput = execFileSync(
    "bash",
    [
      "-c",
      'cd "$1" && find . -type f ! -name "SHA256SUMS" -print0 | sort -z | xargs -0 sha256sum',
      "bash",
      dir,
    ]
  ).toString();
  assert.equal(generated, bashOutput);
  execFileSync("bash", [
    "-c",
    'cd "$1" && sha256sum --check --quiet SHA256SUMS',
    "bash",
    dir,
  ]);
});

test("generateSHA256SUMS: idempotent", () => {
  const dir = tmpdir();
  writeTree(dir, { "a.txt": "hello\n" });
  generateSHA256SUMS(dir);
  const first = fs.readFileSync(path.join(dir, "SHA256SUMS"), "utf8");
  generateSHA256SUMS(dir);
  assert.equal(fs.readFileSync(path.join(dir, "SHA256SUMS"), "utf8"), first);
});

test("generateSHA256SUMS: empty dir produces empty SHA256SUMS file", () => {
  const dir = tmpdir();
  generateSHA256SUMS(dir);
  assert.equal(fs.statSync(path.join(dir, "SHA256SUMS")).size, 0);
  assert.equal(compareChecksums(dir), false);
});

test("compareChecksums: no baseline counts as changed", () => {
  const dir = tmpdir();
  writeTree(dir, { "a.txt": "hello\n" });
  assert.equal(compareChecksums(dir), true);
});

test("compareChecksums: unchanged dir", () => {
  const dir = tmpdir();
  writeTree(dir, { "a.txt": "hello\n", "sub/b.txt": "world\n" });
  generateSHA256SUMS(dir);
  assert.equal(compareChecksums(dir), false);
});

test("compareChecksums: modified file counts as changed", () => {
  const dir = tmpdir();
  writeTree(dir, { "a.txt": "hello\n" });
  generateSHA256SUMS(dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "changed\n");
  assert.equal(compareChecksums(dir), true);
});

test("compareChecksums: added file counts as changed", () => {
  const dir = tmpdir();
  writeTree(dir, { "a.txt": "hello\n" });
  generateSHA256SUMS(dir);
  writeTree(dir, { "b.txt": "new\n" });
  assert.equal(compareChecksums(dir), true);
});

test("compareChecksums: deleted file counts as changed", () => {
  const dir = tmpdir();
  writeTree(dir, { "a.txt": "hello\n", "b.txt": "bye\n" });
  generateSHA256SUMS(dir);
  fs.unlinkSync(path.join(dir, "b.txt"));
  assert.equal(compareChecksums(dir), true);
});

test("compareChecksums: order-insensitive baseline", () => {
  const dir = tmpdir();
  writeTree(dir, { "a.txt": "hello\n", "b.txt": "bye\n" });
  const shuffled = listDataFiles(dir)
    .slice()
    .reverse()
    .map(
      (rel) =>
        `${crypto
          .createHash("sha256")
          .update(fs.readFileSync(path.join(dir, rel)))
          .digest("hex")}  ./${rel}`
    );
  fs.writeFileSync(path.join(dir, "SHA256SUMS"), `${shuffled.join("\n")}\n`);
  assert.equal(compareChecksums(dir), false);
});

test("compareChecksums: malformed baseline counts as changed", () => {
  const dir = tmpdir();
  writeTree(dir, { "a.txt": "hello\n" });
  fs.writeFileSync(path.join(dir, "SHA256SUMS"), "not-a-checksum-line\n");
  assert.equal(compareChecksums(dir), true);
});

// ── import-marker ──

test("import-marker: write → read round-trip", () => {
  const dir = tmpdir();
  writeImportMarker(dir, "abc123");
  assert.equal(readImportMarker(dir), "abc123");
});

test("import-marker: missing file reads empty string", () => {
  const dir = tmpdir();
  assert.equal(readImportMarker(dir), "");
});

test("import-marker: write creates parent dir", () => {
  const dir = path.join(tmpdir(), "nested", "dir");
  writeImportMarker(dir, "def456");
  assert.equal(readImportMarker(dir), "def456");
});

// ── listDataFiles ──

test("listDataFiles: recursive listing excludes nested SHA256SUMS", () => {
  const dir = tmpdir();
  writeTree(dir, {
    "a.txt": "x\n",
    "sub/b.txt": "y\n",
    "sub/SHA256SUMS": "bogus\n",
  });
  assert.deepEqual(listDataFiles(dir), ["a.txt", "sub/b.txt"]);
});

test("listDataFiles: excludes local .import-marker", () => {
  const dir = tmpdir();
  writeTree(dir, { "a.txt": "x\n", ".import-marker": "abc\n" });
  assert.deepEqual(listDataFiles(dir), ["a.txt"]);
});

test("generateSHA256SUMS: marker not hashed, sha256sum --check passes locally", () => {
  const dir = tmpdir();
  writeTree(dir, { "a.txt": "hello\n" });
  writeImportMarker(dir, "abc123");
  generateSHA256SUMS(dir);
  const content = fs.readFileSync(path.join(dir, "SHA256SUMS"), "utf8");
  assert.ok(!content.includes(".import-marker"), "marker must not be hashed");
  execFileSync("bash", [
    "-c",
    'cd "$1" && sha256sum --check --quiet SHA256SUMS',
    "bash",
    dir,
  ]);
});

test("listDataFiles: sorted byte-wise", () => {
  const dir = tmpdir();
  writeTree(dir, { "b.txt": "x\n", "a.txt": "y\n", "A.txt": "z\n" });
  assert.deepEqual(listDataFiles(dir), ["A.txt", "a.txt", "b.txt"]);
});

// ── isZipArchive ──
// Regression guard: apple_health export.zip must be validated post-download
// (replaces the legacy composite's `file | grep -qi "Zip archive"` check).
// Detects ZIP archives by magic bytes — cross-platform, no `file` dependency.

const ZIP_LFH = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // local file header
const ZIP_EOCD = Buffer.from([0x50, 0x4b, 0x05, 0x06]); // empty archive

test("isZipArchive: local file header (PK\\x03\\x04) recognized", () => {
  assert.equal(isZipArchive(Buffer.concat([ZIP_LFH, Buffer.from("rest")])), true);
});

test("isZipArchive: empty archive (PK\\x05\\x06) recognized", () => {
  assert.equal(isZipArchive(ZIP_EOCD), true);
});

test("isZipArchive: spanned-archive marker (PK\\x07\\x08) recognized", () => {
  assert.equal(isZipArchive(Buffer.from([0x50, 0x4b, 0x07, 0x08])), true);
});

test("isZipArchive: LFS pointer text rejected (smudge-leak regression)", () => {
  const pointer = Buffer.from(
    "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 10\n"
  );
  assert.equal(isZipArchive(pointer), false);
});

test("isZipArchive: plain garbage rejected", () => {
  assert.equal(isZipArchive(Buffer.from("this is not a zip")), false);
  assert.equal(isZipArchive(Buffer.from("PK\\x03\\x04")), false); // literal, not bytes
});

test("isZipArchive: too short rejected", () => {
  assert.equal(isZipArchive(Buffer.from("PK")), false);
  assert.equal(isZipArchive(Buffer.alloc(0)), false);
});
