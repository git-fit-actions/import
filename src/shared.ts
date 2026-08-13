import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

/**
 * Static per-source metadata. `branch`/`dir`/`remote`/`cacheKeyPrefix` are NOT
 * stored here — they derive from the `{source}` templates in `resolveConfig`.
 */
export interface SourceBase {
  importCmd: string;
  title: string;
  /**
   * If set, the named file (relative to `dir`) must be present after download
   * and pass {@link isZipArchive}. Restores the legacy composite's
   * `file | grep -qi "Zip archive"` guard against silent LFS-smudge leaks and
   * content-level corruption. Only apple_health sets this (single canonical LFS
   * blob export.zip); multi-file sources rely on git-fit's per-file sniff.
   */
  validateFile?: string;
}

/** Fully-resolved per-source config (templates expanded). */
export interface SourceConfig extends SourceBase {
  branch: string;
  dir: string;
  remote: string;
  cacheKeyPrefix: string;
}

export interface OverrideConfig {
  branch?: string;
  cacheKey?: string;
}

/**
 * Per-source template placeholders. `{source}` expands to the source name
 * (gpx, fit, tcx, 2bulu, apple_health). Defaults AND overrides flow through
 * the same expansion so the action has a single templating mechanism.
 */
export const BRANCH_TEMPLATE = "GitFit/import/{source}";
export const DIR_TEMPLATE = "data/import/{source}";
export const CACHE_KEY_TEMPLATE = "import-{source}-v0-marker";

export function expandTemplate(tmpl: string, source: string): string {
  return tmpl.replace(/\{source\}/g, source);
}

export type SourceStatus = "imported" | "skipped" | "failed";

export interface SourceResult {
  source: string;
  status: SourceStatus;
  dataHash?: string;
  skipReason?: string;
  error?: string;
}

export const KNOWN_SOURCES: Record<string, SourceBase> = {
  apple_health: {
    importCmd: "apple_health",
    title: "Apple Health",
    validateFile: "export.zip",
  },
  "2bulu": {
    importCmd: "tbulu",
    title: "2bulu",
  },
  gpx: {
    importCmd: "gpx",
    title: "GPX",
  },
  fit: {
    importCmd: "fit",
    title: "FIT",
  },
  tcx: {
    importCmd: "tcx",
    title: "TCX",
  },
};

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/**
 * Parse the `sources` input (comma/newline separated) into a deduplicated,
 * validated list. Every entry must be a known source; any invalid entry fails
 * the whole action up front, before any git/cache/filesystem operation.
 */
export function parseSources(sourcesInput: string): string[] {
  const raw = sourcesInput.split(/[,\n]/);
  const seen = new Set<string>();
  const errors: string[] = [];
  const result: string[] = [];
  const supported = Object.keys(KNOWN_SOURCES).join(", ");

  for (const item of raw) {
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    if (!KNOWN_SOURCES[trimmed]) {
      errors.push(
        `Unknown source '${trimmed}'. Supported: ${supported}. Fix: correct the 'sources' input.`
      );
      continue;
    }
    result.push(trimmed);
  }

  if (errors.length > 0) {
    throw new ValidationError(errors.join("; "));
  }
  if (result.length === 0) {
    throw new ValidationError(
      `No valid sources provided. Supported: ${supported}.`
    );
  }
  return result;
}

export function resolveConfig(
  source: string,
  overrides: OverrideConfig = {}
): SourceConfig {
  const defaults = KNOWN_SOURCES[source];
  if (!defaults) {
    throw new ValidationError(
      `Unknown source '${source}'. Supported: ${Object.keys(KNOWN_SOURCES).join(", ")}.`
    );
  }
  const branch = expandTemplate(overrides.branch ?? BRANCH_TEMPLATE, source);
  return {
    branch,
    dir: expandTemplate(DIR_TEMPLATE, source),
    remote: `origin/${branch}`,
    cacheKeyPrefix: expandTemplate(overrides.cacheKey ?? CACHE_KEY_TEMPLATE, source),
    importCmd: defaults.importCmd,
    title: defaults.title,
    validateFile: defaults.validateFile,
  };
}

/**
 * sha256sum of empty input (`printf '' | sha256sum | cut -d' ' -f1`).
 * Signals "no data files" in the branch directory.
 */
export const EMPTY_TREE_HASH =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/**
 * Compute the directory-level data hash from `git ls-tree -r` stdout.
 *
 * Input lines: `<mode> <type> <sha>\t<path>`.
 * Marker files (SHA256SUMS, .import-marker) are excluded; the blob SHA of each
 * remaining entry is hashed — byte-identical to:
 *
 *   git ls-tree -r <remote> <dir> \
 *     | grep -v '/SHA256SUMS$\|/\.import-marker$' \
 *     | awk '{print $3}' | sha256sum | cut -d' ' -f1
 */
export function computeTreeHashFromLS(lsOutput: string): string {
  const hashes: string[] = [];
  for (const line of lsOutput.split("\n")) {
    const trimmed = line.trimEnd();
    if (!trimmed) {
      continue;
    }
    const tabIdx = trimmed.indexOf("\t");
    if (tabIdx < 0) {
      continue;
    }
    const filePath = trimmed.substring(tabIdx + 1);
    if (
      filePath.endsWith("/SHA256SUMS") ||
      filePath.endsWith("/.import-marker") ||
      filePath === "SHA256SUMS" ||
      filePath === ".import-marker"
    ) {
      continue;
    }
    const parts = trimmed.substring(0, tabIdx).split(/\s+/);
    if (parts.length >= 3) {
      hashes.push(parts[2]);
    }
  }
  if (hashes.length === 0) {
    return EMPTY_TREE_HASH;
  }
  return crypto.createHash("sha256").update(hashes.join("\n") + "\n").digest("hex");
}

function compareBytewise(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * Recursively list data files (excluding marker files: any file named
 * SHA256SUMS, or the local-only .import-marker state file), sorted byte-wise
 * to match `sort -z` under LC_ALL=C. The .import-marker exclusion matches the
 * legacy `find . -type f ! -name 'SHA256SUMS' ! -name '.modified-at'`: the
 * marker is never pushed to the branch, so including it would break branch-side
 * `sha256sum -c` recovery checks.
 */
export function listDataFiles(dir: string): string[] {
  const results: string[] = [];
  const walk = (prefix: string): void => {
    const full = prefix ? path.join(dir, prefix) : dir;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(full, { withFileTypes: true });
    } catch {
      return;
    }
    dirents.sort((a, b) => compareBytewise(a.name, b.name));
    for (const d of dirents) {
      const rel = prefix ? `${prefix}/${d.name}` : d.name;
      if (d.isDirectory()) {
        walk(rel);
      } else if (
        d.isFile() &&
        d.name !== "SHA256SUMS" &&
        d.name !== ".import-marker"
      ) {
        results.push(rel);
      }
    }
  };
  walk("");
  results.sort(compareBytewise);
  return results;
}

export function hashFile(filePath: string): string {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

export function computeChecksumMap(dir: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rel of listDataFiles(dir)) {
    map.set(rel, hashFile(path.join(dir, rel)));
  }
  return map;
}

export function parseChecksumFile(filePath: string): {
  map: Map<string, string>;
  malformed: boolean;
} {
  const map = new Map<string, string>();
  let malformed = false;
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return { map, malformed: true };
  }
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (!m) {
      malformed = true;
      continue;
    }
    map.set(m[2].replace(/^\.\//, ""), m[1]);
  }
  return { map, malformed };
}

function mapsEqual(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (b.get(key) !== value) return false;
  }
  return true;
}

/**
 * Whether the directory's content differs from its SHA256SUMS baseline.
 * Set-based comparison (order independent); a missing or malformed baseline
 * counts as changed.
 */
export function compareChecksums(dir: string): boolean {
  const baselinePath = path.join(dir, "SHA256SUMS");
  if (!isFile(baselinePath)) {
    return true;
  }
  const { map: baseline, malformed } = parseChecksumFile(baselinePath);
  if (malformed) {
    return true;
  }
  return !mapsEqual(baseline, computeChecksumMap(dir));
}

/**
 * Regenerate SHA256SUMS, byte-identical to
 * `find . -type f ! -name 'SHA256SUMS' -print0 | sort -z | xargs -0 sha256sum`
 * (`HASH  ./path` lines, trailing newline, empty file for an empty dir).
 */
export function generateSHA256SUMS(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const lines = listDataFiles(dir).map(
    (rel) => `${hashFile(path.join(dir, rel))}  ./${rel}`
  );
  const content = lines.length > 0 ? `${lines.join("\n")}\n` : "";
  fs.writeFileSync(path.join(dir, "SHA256SUMS"), content);
}

export function readImportMarker(dir: string): string {
  try {
    return fs.readFileSync(path.join(dir, ".import-marker"), "utf8").trim();
  } catch {
    return "";
  }
}

export function writeImportMarker(dir: string, hash: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".import-marker"), hash);
}

export function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function countFiles(dir: string): number {
  try {
    return listDataFiles(dir).length;
  } catch {
    return 0;
  }
}

/**
 * Detect ZIP archives by magic bytes. ZIP files begin with either a local
 * file header (PK\x03\x04) or, for an empty archive, an end-of-central-directory
 * record (PK\x05\x06); the spanned-archive marker (PK\x07\x08) is also accepted.
 * Cross-platform byte check — no `file` binary dependency. Replaces the legacy
 * composite's `file export.zip | grep -qi "Zip archive"` guard.
 *
 * Returns false for non-zip content including a leaked LFS pointer (the case
 * where `git lfs smudge` produced textual pointer output instead of the blob).
 */
export function isZipArchive(buf: Buffer): boolean {
  if (buf.length < 4) return false;
  const a = buf[0];
  const b = buf[1];
  if (a !== 0x50 || b !== 0x4b) return false; // "PK"
  const c = buf[2];
  const d = buf[3];
  return (
    (c === 0x03 && d === 0x04) ||
    (c === 0x05 && d === 0x06) ||
    (c === 0x07 && d === 0x08)
  );
}
