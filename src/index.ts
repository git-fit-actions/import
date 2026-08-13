import * as core from "@actions/core";
import * as cache from "@actions/cache";
import * as exec from "@actions/exec";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  EMPTY_TREE_HASH,
  KNOWN_SOURCES,
  SourceConfig,
  SourceResult,
  computeTreeHashFromLS,
  generateSHA256SUMS,
  isFile,
  isZipArchive,
  parseSources,
  readImportMarker,
  resolveConfig,
  writeImportMarker,
} from "./shared";

interface GitResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error: Error | null;
}

function git(
  args: string[],
  env: NodeJS.ProcessEnv = {}
): GitResult {
  const r = spawnSync("git", args, {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return {
    status: r.status,
    stdout: typeof r.stdout === "string" ? r.stdout : "",
    stderr: typeof r.stderr === "string" ? r.stderr : "",
    error: r.error ?? null,
  };
}

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Resolve whether the import branch exists on `origin`.
 *
 * `git ls-remote --exit-code`:
 *   - exit 0  → refs matched, branch exists
 *   - exit 2  → no matching refs but repo reachable (genuine branch absence)
 *   - 128/null → auth/network/infra failure — caller must throw, never silently
 *     skip, otherwise a transient infra blip would be misreported as "no-branch"
 *     and silently swallow the source.
 */
function checkBranch(branch: string): boolean {
  const r = git(["ls-remote", "--exit-code", "origin", `refs/heads/${branch}`]);
  if (r.status === 0) return true;
  if (r.status === 2) return false;
  throw new Error(
    `ls-remote ${branch} failed (status=${r.status ?? "null"}): ${r.stderr.trim() || r.error?.message || "unknown"}. Fix: verify git credentials and origin reachability.`
  );
}

function computeTreeHash(remote: string, dir: string): string {
  const r = git(["ls-tree", "-r", remote, dir]);
  if (r.status !== 0) {
    // Defensive: a fetch just succeeded so the ref exists, but a corrupt repo
    // / bad ref name could still surface here. Treat git-level failure as "no
    // data" rather than crash. The absent-path-but-ref-ok case returns status
    // 0 with empty stdout and is handled downstream by computeTreeHashFromLS →
    // EMPTY_TREE_HASH.
    return EMPTY_TREE_HASH;
  }
  return computeTreeHashFromLS(r.stdout);
}

function downloadFiles(cfg: SourceConfig): number {
  fs.mkdirSync(cfg.dir, { recursive: true });

  // `-z` → NUL-delimited raw paths, never shell-quoted (git quotes paths with
  // spaces/unicode unless -z is given).
  const ls = git(["ls-tree", "-r", "-z", "--name-only", cfg.remote, cfg.dir]);
  if (ls.status !== 0) {
    throw new Error(`git ls-tree ${cfg.dir} failed: ${ls.stderr.trim()}`);
  }
  const files = ls.stdout
    .split("\0")
    .filter(Boolean)
    .filter(
      (f) => !f.endsWith("/SHA256SUMS") && !f.endsWith("/.import-marker")
    );
  if (files.length === 0) {
    return 0;
  }

  for (const remoteFile of files) {
    const relPath = remoteFile.startsWith(cfg.dir + "/")
      ? remoteFile.substring(cfg.dir.length + 1)
      : remoteFile;
    const localPath = path.join(cfg.dir, relPath);
    fs.mkdirSync(path.dirname(localPath), { recursive: true });

    // bash pipe (stdout → file, bypasses Node's spawnSync large-buffer stall):
    // matches the legacy composite's `git show <ref>:<f> | git lfs smudge >
    // file` byte-for-byte. smudge passes through non-LFS content unchanged;
    // for LFS pointers it fetches the real blob. `set -o pipefail` propagates
    // a git show failure (bash default only takes the last command's exit).
    const ref = `${cfg.remote}:${remoteFile}`;
    const cmd = `set -o pipefail; git show ${shellQuote(ref)} | git lfs smudge > ${shellQuote(localPath)}`;
    const r = spawnSync("bash", ["-c", cmd], { encoding: "utf8" });
    if (r.status !== 0) {
      throw new Error(
        `download ${remoteFile} failed (status=${r.status ?? "null"}): ${r.stderr.trim() || r.error?.message || "unknown"}. Fix: verify LFS auth and network; retry the workflow.`
      );
    }
  }
  return files.length;
}

async function runImport(cfg: SourceConfig, dbPath: string): Promise<void> {
  try {
    await exec.exec(
      "bundle",
      ["exec", "git", "fit", "import", cfg.importCmd],
      { env: { ...process.env, GIT_FIT_DATABASE_PATH: dbPath } }
    );
  } catch (e) {
    throw new Error(
      `git fit import ${cfg.importCmd} failed: ${e instanceof Error ? e.message : String(e)}. Fix: ensure Ruby + bundler are set up (ruby/setup-ruby).`
    );
  }
}

/**
 * Push the freshly generated SHA256SUMS back to the import branch:
 * overlay our checksum on the branch's current tree, commit, push. Any failure
 * is non-blocking (no push auth assumed) — warn and continue. (Replaces the
 * now-removed scripts/append-to-branch.sh.)
 */
function pushChecksums(cfg: SourceConfig): void {
  const sha256Path = path.join(cfg.dir, "SHA256SUMS");
  if (!isFile(sha256Path)) {
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-fit-import-"));
  const tmpIndex = path.join(tmpDir, "index");
  const indexEnv = { GIT_INDEX_FILE: tmpIndex };

  try {
    const fetch = git(["fetch", "origin", cfg.branch]);
    if (fetch.status !== 0) {
      core.warning(`[${cfg.title}] git fetch ${cfg.branch} failed — skip push`);
      return;
    }

    const parentResult = git(["rev-parse", `origin/${cfg.branch}`]);
    if (parentResult.status !== 0) {
      core.warning(`[${cfg.title}] origin/${cfg.branch} not found — skip push`);
      return;
    }
    const parent = parentResult.stdout.trim();

    const check = (r: GitResult, label: string): string => {
      if (r.status !== 0) {
        throw new Error(`${label} failed: ${r.stderr.trim()}`);
      }
      return r.stdout.trim();
    };

    check(git(["read-tree", "--empty"], indexEnv), "read-tree");
    check(git(["read-tree", parent], indexEnv), "read-tree");
    check(git(["add", "-f", sha256Path], indexEnv), "add");

    const diff = git(["diff-index", "--cached", "--quiet", parent], indexEnv);
    if (diff.status === 0) {
      core.info(`[${cfg.title}] SHA256SUMS unchanged on branch — skip push`);
      return;
    }

    const tree = check(git(["write-tree"], indexEnv), "write-tree");
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
    const commit = check(
      git(
        [
          "-c", "user.name=git-fit-bot",
          "-c", "user.email=bot@git-fit-actions",
          "commit-tree", "-p", parent, "-m", `store(v0): ${stamp}`, tree,
        ],
        indexEnv
      ),
      "commit-tree"
    );

    const push = git(["push", "origin", `${commit}:refs/heads/${cfg.branch}`]);
    if (push.status !== 0) {
      core.warning(
        `[${cfg.title}] push to ${cfg.branch} failed (non-blocking): ${push.stderr.trim()}`
      );
    } else {
      core.info(
        `[${cfg.title}] Pushed SHA256SUMS to ${cfg.branch} (${parent.slice(0, 7)} → ${commit.slice(0, 7)})`
      );
    }
  } catch (e) {
    core.warning(
      `[${cfg.title}] push checksums failed (non-blocking): ${e instanceof Error ? e.message : String(e)}`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function storeState(
  cfg: SourceConfig,
  dataHash: string,
  storeStateFlag: boolean
): Promise<void> {
  writeImportMarker(cfg.dir, dataHash);
  generateSHA256SUMS(cfg.dir);

  const markerPaths = [
    path.join(cfg.dir, ".import-marker"),
    path.join(cfg.dir, "SHA256SUMS"),
  ];
  const cacheKey = `${cfg.cacheKeyPrefix}-${dataHash}`;
  try {
    const saved = await cache.saveCache(markerPaths, cacheKey);
    if (saved) {
      core.info(`[${cfg.title}] Cache saved (key: ${cacheKey.slice(0, 48)}…)`);
    } else {
      core.warning(`[${cfg.title}] Cache save skipped — key may be reserved by another job`);
    }
  } catch (e) {
    core.warning(`[${cfg.title}] Cache save error: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (storeStateFlag) {
    pushChecksums(cfg);
  }
}

async function processSource(
  source: string,
  cfg: SourceConfig,
  dbPath: string,
  storeStateFlag: boolean
): Promise<SourceResult> {
  core.info(`[${cfg.title}] Starting…`);

  if (!checkBranch(cfg.branch)) {
    core.info(`[${cfg.title}] No branch ${cfg.branch} — skip`);
    return { source, status: "skipped", skipReason: "no-branch" };
  }

  const fetch = git(["fetch", "origin", `+refs/heads/${cfg.branch}:refs/remotes/${cfg.remote}`]);
  if (fetch.status !== 0) {
    throw new Error(`git fetch ${cfg.branch} failed: ${fetch.stderr.trim()}`);
  }

  const dataHash = computeTreeHash(cfg.remote, cfg.dir);
  core.info(`[${cfg.title}] data_hash=${dataHash.slice(0, 12)}`);
  if (dataHash === EMPTY_TREE_HASH) {
    return {
      source,
      status: "skipped",
      dataHash,
      skipReason: "no-data-files",
    };
  }

  const markerPaths = [
    path.join(cfg.dir, ".import-marker"),
    path.join(cfg.dir, "SHA256SUMS"),
  ];
  const cacheKey = `${cfg.cacheKeyPrefix}-${dataHash}`;
  try {
    const matched = await cache.restoreCache(markerPaths, cacheKey, [`${cfg.cacheKeyPrefix}-`]);
    core.info(`[${cfg.title}] Cache ${matched ? "hit" : "miss"} (key: ${cacheKey.slice(0, 48)}…)`);
  } catch (e) {
    core.warning(`[${cfg.title}] Cache restore error: ${e instanceof Error ? e.message : String(e)}`);
  }

  const lastHash = readImportMarker(cfg.dir);
  if (lastHash === dataHash) {
    core.info(`[${cfg.title}] Unchanged (${dataHash.slice(0, 12)}) — skip`);
    return { source, status: "skipped", dataHash, skipReason: "unchanged" };
  }
  core.info(`[${cfg.title}] ${lastHash ? "Changed" : "First import"} — ${lastHash.slice(0, 12)} → ${dataHash.slice(0, 12)}`);

  const fileCount = downloadFiles(cfg);
  if (fileCount === 0) {
    throw new Error(`no data files extracted from ${cfg.branch}`);
  }
  core.info(`[${cfg.title}] Downloaded ${fileCount} file(s)`);

  if (cfg.validateFile) {
    const target = path.join(cfg.dir, cfg.validateFile);
    if (!isFile(target)) {
      throw new Error(
        `expected ${cfg.validateFile} missing after download from ${cfg.branch}. Fix: check the branch tree or override 'dir'/'branch'.`
      );
    }
    if (!isZipArchive(fs.readFileSync(target))) {
      throw new Error(
        `${cfg.validateFile} is not a valid zip archive — possible LFS smudge leak or content corruption. Fix: verify git-lfs on the runner and the ${cfg.validateFile} blob on ${cfg.branch}.`
      );
    }
    core.info(`[${cfg.title}] Validated ${cfg.validateFile}`);
  }

  core.info(`[${cfg.title}] Running git fit import ${cfg.importCmd}…`);
  await runImport(cfg, dbPath);

  await storeState(cfg, dataHash, storeStateFlag);
  return { source, status: "imported", dataHash };
}

function summaryTable(results: SourceResult[]): string {
  const escape = (s: string): string => s.replace(/\|/g, "\\|");
  let out = "### GitFit Import\n\n| Source | Status | data_hash | Details |\n|--------|--------|-----------|---------|\n";
  for (const r of results) {
    const title = KNOWN_SOURCES[r.source]?.title ?? r.source;
    const hash = r.dataHash ? r.dataHash.slice(0, 12) : "—";
    const details =
      r.status === "skipped" && r.skipReason
        ? r.skipReason
        : r.status === "failed" && r.error
          ? r.error
          : "—";
    out += `| ${escape(title)} | ${r.status} | ${hash} | ${escape(details)} |\n`;
  }
  return out;
}

async function run(): Promise<void> {
  const sources = parseSources(core.getInput("sources"));
  const dbPath = core.getInput("db-path") || "data/db/workouts.db";
  const storeStateFlag = core.getInput("store-state") !== "false";
  const overrides = {
    branch: core.getInput("branch") || undefined,
    cacheKey: core.getInput("cache-key") || undefined,
  };

  const lfsInstall = git(["lfs", "install"]);
  if (lfsInstall.status !== 0) {
    core.warning(`git lfs install failed — LFS files may not download: ${lfsInstall.stderr.trim()}`);
  }

  const results: SourceResult[] = [];
  const importedSources: string[] = [];
  const skippedSources: string[] = [];

  for (const src of sources) {
    const cfg = resolveConfig(src, overrides);
    try {
      const result = await processSource(src, cfg, dbPath, storeStateFlag);
      results.push(result);
      core.setOutput(`data_hash_${src}`, result.dataHash ?? "");
      core.setOutput(`skip_reason_${src}`, result.skipReason ?? "");
      core.setOutput(`imported_${src}`, result.status === "imported" ? "true" : "false");
      if (result.status === "imported") {
        importedSources.push(src);
        core.info(`[${cfg.title}] Done — imported`);
      } else if (result.status === "skipped") {
        skippedSources.push(src);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ source: src, status: "failed", error: msg });
      core.setOutput(`data_hash_${src}`, "");
      core.setOutput(`skip_reason_${src}`, "");
      core.setOutput(`imported_${src}`, "false");
      core.error(`[${cfg.title}] Failed: ${msg}`);
    }
  }

  core.setOutput("changed", results.some((r) => r.status === "imported") ? "true" : "false");
  core.setOutput("imported_sources", importedSources.join(","));
  core.setOutput("skipped_sources", skippedSources.join(","));

  await core.summary.addRaw(summaryTable(results)).write();

  if (results.some((r) => r.status === "failed")) {
    core.setFailed(
      "One or more sources failed to import. Fix the issue and re-run the workflow."
    );
  }
}

run().catch((err: unknown) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
