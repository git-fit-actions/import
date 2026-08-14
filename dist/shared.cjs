"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/shared.ts
var shared_exports = {};
__export(shared_exports, {
  BRANCH_TEMPLATE: () => BRANCH_TEMPLATE,
  CACHE_KEY_TEMPLATE: () => CACHE_KEY_TEMPLATE,
  DIR_TEMPLATE: () => DIR_TEMPLATE,
  EMPTY_TREE_HASH: () => EMPTY_TREE_HASH,
  KNOWN_SOURCES: () => KNOWN_SOURCES,
  LEGEND: () => LEGEND,
  ValidationError: () => ValidationError,
  compareChecksums: () => compareChecksums,
  computeChecksumMap: () => computeChecksumMap,
  computeTreeHashFromLS: () => computeTreeHashFromLS,
  countFiles: () => countFiles,
  expandTemplate: () => expandTemplate,
  generateSHA256SUMS: () => generateSHA256SUMS,
  glyphFor: () => glyphFor,
  hashFile: () => hashFile,
  isDirectory: () => isDirectory,
  isFile: () => isFile,
  isZipArchive: () => isZipArchive,
  listDataFiles: () => listDataFiles,
  needsLegend: () => needsLegend,
  parseChecksumFile: () => parseChecksumFile,
  parseSources: () => parseSources,
  readImportMarker: () => readImportMarker,
  resolveConfig: () => resolveConfig,
  writeImportMarker: () => writeImportMarker
});
module.exports = __toCommonJS(shared_exports);
var crypto = __toESM(require("crypto"));
var fs = __toESM(require("fs"));
var path = __toESM(require("path"));
var BRANCH_TEMPLATE = "GitFit/import/{source}";
var DIR_TEMPLATE = "data/import/{source}";
var CACHE_KEY_TEMPLATE = "import-{source}-v0-marker";
function expandTemplate(tmpl, source) {
  return tmpl.replace(/\{source\}/g, source);
}
var KNOWN_SOURCES = {
  apple_health: {
    importCmd: "apple_health",
    title: "Apple Health",
    validateFile: "export.zip"
  },
  "2bulu": {
    importCmd: "tbulu",
    title: "2bulu"
  },
  gpx: {
    importCmd: "gpx",
    title: "GPX"
  },
  fit: {
    importCmd: "fit",
    title: "FIT"
  },
  tcx: {
    importCmd: "tcx",
    title: "TCX"
  }
};
var ValidationError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
};
function parseSources(sourcesInput) {
  const raw = sourcesInput.split(/[,\n]/);
  const seen = /* @__PURE__ */ new Set();
  const errors = [];
  const result = [];
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
function resolveConfig(source, overrides = {}) {
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
    validateFile: defaults.validateFile
  };
}
var EMPTY_TREE_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
function computeTreeHashFromLS(lsOutput) {
  const hashes = [];
  for (const line of lsOutput.split("\n")) {
    const trimmed = line.trimEnd();
    if (!trimmed) {
      continue;
    }
    const tabIdx = trimmed.indexOf("	");
    if (tabIdx < 0) {
      continue;
    }
    const filePath = trimmed.substring(tabIdx + 1);
    if (filePath.endsWith("/SHA256SUMS") || filePath.endsWith("/.import-marker") || filePath === "SHA256SUMS" || filePath === ".import-marker") {
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
function compareBytewise(a, b) {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}
function listDataFiles(dir) {
  const results = [];
  const walk = (prefix) => {
    const full = prefix ? path.join(dir, prefix) : dir;
    let dirents;
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
      } else if (d.isFile() && d.name !== "SHA256SUMS" && d.name !== ".import-marker") {
        results.push(rel);
      }
    }
  };
  walk("");
  results.sort(compareBytewise);
  return results;
}
function hashFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}
function computeChecksumMap(dir) {
  const map = /* @__PURE__ */ new Map();
  for (const rel of listDataFiles(dir)) {
    map.set(rel, hashFile(path.join(dir, rel)));
  }
  return map;
}
function parseChecksumFile(filePath) {
  const map = /* @__PURE__ */ new Map();
  let malformed = false;
  let content;
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
function mapsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (b.get(key) !== value) return false;
  }
  return true;
}
function compareChecksums(dir) {
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
function generateSHA256SUMS(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const lines = listDataFiles(dir).map(
    (rel) => `${hashFile(path.join(dir, rel))}  ./${rel}`
  );
  const content = lines.length > 0 ? `${lines.join("\n")}
` : "";
  fs.writeFileSync(path.join(dir, "SHA256SUMS"), content);
}
function readImportMarker(dir) {
  try {
    return fs.readFileSync(path.join(dir, ".import-marker"), "utf8").trim();
  } catch {
    return "";
  }
}
function writeImportMarker(dir, hash) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".import-marker"), hash);
}
function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
function countFiles(dir) {
  try {
    return listDataFiles(dir).length;
  } catch {
    return 0;
  }
}
function isZipArchive(buf) {
  if (buf.length < 4) return false;
  const a = buf[0];
  const b = buf[1];
  if (a !== 80 || b !== 75) return false;
  const c = buf[2];
  const d = buf[3];
  return c === 3 && d === 4 || c === 5 && d === 6 || c === 7 && d === 8;
}
var LEGEND = "_\u2705 \u6B63\u5E38\u4EA7\u51FA \xB7 \u23ED\uFE0F \u9884\u6599\u5185\u65E0\u53D8\u5316/\u515C\u5E95 \xB7 \u274C \u5931\u8D25_";
var GLYPH_OK = /* @__PURE__ */ new Set(["hit", "ok", "saved", "imported", "attempted", "changed", "pushed", "present", "cache"]);
var GLYPH_SKIP = /* @__PURE__ */ new Set(["miss", "skipped", "unchanged", "none", "git"]);
var GLYPH_FAIL = /* @__PURE__ */ new Set(["failed", "errors", "missing"]);
var LEGEND_TRIGGER = /* @__PURE__ */ new Set(["miss", "failed", "errors", "missing"]);
function needsLegend(statuses) {
  return statuses.some((s) => LEGEND_TRIGGER.has(s.split(/\s/)[0]));
}
function glyphFor(status) {
  if (GLYPH_OK.has(status) || GLYPH_OK.has(status.split(/\s/)[0])) {
    return `\u2705 ${status}`;
  }
  if (GLYPH_SKIP.has(status) || GLYPH_SKIP.has(status.split(/\s/)[0])) {
    return `\u23ED\uFE0F ${status}`;
  }
  if (GLYPH_FAIL.has(status) || GLYPH_FAIL.has(status.split(/\s/)[0])) {
    return `\u274C ${status}`;
  }
  return status;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  BRANCH_TEMPLATE,
  CACHE_KEY_TEMPLATE,
  DIR_TEMPLATE,
  EMPTY_TREE_HASH,
  KNOWN_SOURCES,
  LEGEND,
  ValidationError,
  compareChecksums,
  computeChecksumMap,
  computeTreeHashFromLS,
  countFiles,
  expandTemplate,
  generateSHA256SUMS,
  glyphFor,
  hashFile,
  isDirectory,
  isFile,
  isZipArchive,
  listDataFiles,
  needsLegend,
  parseChecksumFile,
  parseSources,
  readImportMarker,
  resolveConfig,
  writeImportMarker
});
