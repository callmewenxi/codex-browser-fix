#!/usr/bin/env node
/*
 * codex-browser-mac-fix — macOS/Windows port of the "local browser request
 * identification" compatibility fix for Codex Desktop.
 *
 * Upstream reference: BigPizzaV3/CodexPlusPlus PR #2208 (Windows only).
 *
 * Problem this solves
 * -------------------
 * The bundled browser service decides whether the Chrome/Edge extension must
 * attach an agent-identification header by reading a cloud gate that is only
 * reachable with a ChatGPT login. Running Codex with an API key / custom
 * provider, that call fails with "Codex auth token is unavailable" and every
 * tab command (list, open, navigate, read) is rejected. Browser discovery
 * still succeeds, which is why the extension looks connected but does nothing.
 *
 * What this patch changes
 * -----------------------
 * Exactly one thing: the callback the service uses to answer "must this
 * browser attach identification headers?". When the connected client is a
 * known Chrome/Edge extension and the local control file explicitly says
 * requireIdentification=true, the answer is decided locally instead of by the
 * cloud gate. Everything else keeps running the vendor code path, including
 * site restrictions, enterprise policy, operation approvals, and user-stop
 * handling.
 *
 * It does not create credentials, does not read or modify auth.json, does not
 * change config.toml, and does not fake a ChatGPT identity.
 *
 * Usage
 * -----
 *   node codex-browser-mac-fix.mjs                  # apply (user-writable copies)
 *   node codex-browser-mac-fix.mjs --check          # report drift, exit 1 if unpatched
 *   node codex-browser-mac-fix.mjs --restore        # restore original files
 *   node codex-browser-mac-fix.mjs --include-app-bundle   # also patch inside ChatGPT.app
 *
 * Updates may replace these files. Test browser use before deciding to reapply.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const HOME = os.homedir();
const FIX_DIR = path.join(HOME, process.platform === "win32" ? ".codex-browser-windows-fix" : ".codex-browser-mac-fix");
const BACKUP_DIR = path.join(FIX_DIR, "backups");
const STATE_FILE = path.join(FIX_DIR, "state.json");
const CONTROL_FILE = path.join(FIX_DIR, "control.json");

const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, ".codex");
const APP_BUNDLE = "/Applications/ChatGPT.app";
const APP_VERSION_PLIST = path.join(APP_BUNDLE, "Contents/Info.plist");

const MARKER = "__cppMacIdReader";

// Chrome / Edge stable extension IDs, as registered by the bundled service.
const EXTENSION_IDS = {
  chrome: "hehggadaopoacecdllhhajmbjkdcmajg",
  edge: "odlomjlbamekndcpllcnffbgeohgkmjh",
};

// The single construction site that wires the request-identification callback
// into each per-client browser instance.
const CONSTRUCTOR_RE =
  /new (\w+)\(r,this\.clientApi,\(\)=>(\w+)\(this\.runtime\),this\.turnEndedTracker,(\w+)\)/g;

const APP_BUNDLE_TARGETS = [
  path.join(
    APP_BUNDLE,
    "Contents/Resources/cua_node/lib/node_modules/@oai/browser-desktop/scripts/browser-service.mjs",
  ),
  path.join(
    APP_BUNDLE,
    "Contents/Resources/cua_node/lib/node_modules/@oai/cua/dist/lib/js/oai_js_browser/dist/skill/scripts/browser-service.mjs",
  ),
];

export function buildHelperSource(controlFile = CONTROL_FILE) {
  const controlLiteral = JSON.stringify(controlFile);
  return `
import * as __cppFsp from "node:fs/promises";
/* codex-browser-mac-fix: local request-identification reader (see ~/.codex-browser-mac-fix) */
function ${MARKER}(getTurnMetadata,fallback){
  return async function(){
    try{
      const info=this&&this.clientInfo;
      if(!info||info.type!=="extension")return fallback();
      if(typeof info.agentRequestHeaderEnabled!=="boolean")return fallback();
      const md=info.metadata||{},family=info.family;
      const instanceId=md.extensionInstanceId,extensionId=md.extensionId;
      const supported=(family==="edge"&&extensionId===${JSON.stringify(EXTENSION_IDS.edge)})||(family==="chrome"&&extensionId===${JSON.stringify(EXTENSION_IDS.chrome)});
      if(!supported)return fallback();
      const turn=typeof getTurnMetadata==="function"?getTurnMetadata():null;
      const sessionId=turn&&turn.session_id,turnId=turn&&turn.turn_id;
      if(typeof instanceId!=="string"||!instanceId)return fallback();
      if(typeof sessionId!=="string"||!sessionId||typeof turnId!=="string"||!turnId)return fallback();
      const st=await __cppFsp.lstat(${controlLiteral});
      if(!st.isFile()||st.size>4096)return fallback();
      const control=JSON.parse(await __cppFsp.readFile(${controlLiteral},"utf8"));
      const after=typeof getTurnMetadata==="function"?getTurnMetadata():null;
      if(this.clientInfo!==info)return fallback();
      if(!after||after.session_id!==sessionId||after.turn_id!==turnId)return fallback();
      if(!control||control.schema!==1||control.requireIdentification!==true)return fallback();
      return true;
    }catch{return fallback();}
  };
}
`;
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function appVersion() {
  if (process.platform !== "darwin") return "unknown";
  try {
    return execFileSync(
      "plutil",
      ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", APP_VERSION_PLIST],
      { encoding: "utf8" },
    ).trim();
  } catch {
    return "unknown";
  }
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Discover every browser-service.mjs that the runtime can actually load. */
function discoverTargets({ includeAppBundle }) {
  const found = new Set();
  const pluginRoots = [
    path.join(CODEX_HOME, "plugins/cache/openai-bundled"),
    path.join(CODEX_HOME, ".tmp/bundled-marketplaces/openai-bundled/plugins"),
  ];
  for (const root of pluginRoots) {
    for (const plugin of listDir(root)) {
      if (!plugin.isDirectory()) continue;
      const bases = [
        path.join(root, plugin.name),
        ...listDir(path.join(root, plugin.name)).map((entry) =>
          path.join(root, plugin.name, entry.name),
        ),
      ];
      for (const base of bases) {
        const candidate = path.join(base, "scripts/browser-service.mjs");
        if (fs.existsSync(candidate)) found.add(candidate);
      }
    }
  }
  if (includeAppBundle) {
    for (const candidate of APP_BUNDLE_TARGETS) {
      if (fs.existsSync(candidate)) found.add(candidate);
    }
  }
  const resolved = new Map();
  for (const candidate of found) {
    const real = fs.realpathSync(candidate);
    if (!resolved.has(real)) resolved.set(real, candidate);
  }
  return [...resolved.keys()].sort();
}

export function patchSource(source) {
  if (source.includes(MARKER)) return { status: "already" };

  const matches = [...source.matchAll(CONSTRUCTOR_RE)];
  if (matches.length === 0) return { status: "no-match" };
  if (matches.length > 1) return { status: "ambiguous", count: matches.length };

  const match = matches[0];
  const [, clientClass, metadataFn, callbackFn] = match;
  const rebuilt =
    `new ${clientClass}(r,this.clientApi,()=>${metadataFn}(this.runtime),this.turnEndedTracker,` +
    `${MARKER}(()=>${metadataFn}(this.runtime),${callbackFn}))`;

  const out =
    source.slice(0, match.index) +
    rebuilt +
    source.slice(match.index + match[0].length) +
    buildHelperSource();

  if (!out.includes(MARKER)) return { status: "no-match" };
  return { status: "patched", out };
}

/** Parse the candidate with Node before it is allowed to replace a live file. */
function parses(source) {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-browser-mac-fix-"));
  const probe = path.join(probeDir, "probe.mjs");
  try {
    fs.writeFileSync(probe, source);
    execFileSync(process.execPath, ["--check", probe], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { version: 1, entries: [] };
  }
}

function writeState(state) {
  fs.mkdirSync(FIX_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

function ensureControlFile() {
  fs.mkdirSync(FIX_DIR, { recursive: true });
  if (!fs.existsSync(CONTROL_FILE)) {
    fs.writeFileSync(
      CONTROL_FILE,
      JSON.stringify({ schema: 1, requireIdentification: true }, null, 2) + "\n",
    );
  }
}

function backupFor(file, contents) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const backup = path.join(BACKUP_DIR, `${sha256(contents).slice(0, 16)}-${path.basename(file)}`);
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, contents);
  return backup;
}

function applyTo(file) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) return { file, status: "skipped-symlink" };
  const source = fs.readFileSync(file, "utf8");
  const result = patchSource(source);
  if (result.status !== "patched") return { file, status: result.status };
  if (!parses(result.out)) return { file, status: "rejected-syntax" };

  const backup = backupFor(file, source);
  fs.writeFileSync(file, result.out);

  const state = readState();
  state.version = 1;
  state.updatedAt = new Date().toISOString();
  state.appVersion = appVersion();
  state.entries = state.entries.filter((entry) => entry.file !== file);
  state.entries.push({
    file,
    backup,
    sha256Before: sha256(source),
    sha256After: sha256(result.out),
    appVersion: state.appVersion,
    updatedAt: state.updatedAt,
  });
  writeState(state);
  return { file, status: "patched", backup };
}

export function restoreFile(file, state = readState(), backupDir = BACKUP_DIR) {
  const entry = state.entries.find((candidate) => candidate.file === file);
  if (!fs.existsSync(file)) return { file, status: "missing" };
  const source = fs.readFileSync(file, "utf8");
  if (!source.includes(MARKER)) return { file, status: "already-original" };
  if (!entry) return { file, status: "no-state" };
  if (sha256(source) !== entry.sha256After) return { file, status: "modified-since-patch" };

  const suffix = `-${path.basename(file)}`;
  const candidates = [
    ...(entry && fs.existsSync(entry.backup) ? [entry.backup] : []),
    ...listDir(backupDir)
      .filter((item) => item.isFile())
      .map((item) => path.join(backupDir, item.name))
      .filter((candidate) => candidate.endsWith(suffix))
      .sort(),
  ];
  const backupPath = candidates.find((candidate) =>
    sha256(fs.readFileSync(candidate, "utf8")) === entry.sha256Before);
  if (!backupPath) return { file, status: "no-matching-backup" };

  fs.writeFileSync(file, fs.readFileSync(backupPath));
  return { file, status: "restored", backup: backupPath };
}

function classify(file) {
  if (!fs.existsSync(file)) return "missing";
  const source = fs.readFileSync(file, "utf8");
  if (source.includes(MARKER)) return "patched";
  if (patchSource(source).status === "patched") return "unpatched";
  return "unsupported";
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help")) {
    console.log(`Usage: node codex-browser-mac-fix.mjs [options]

Default: apply to discovered user-writable browser service files.
  --check                Inspect patch markers without changing files
  --restore              Restore only exact, recorded backups
  --include-app-bundle   macOS only: include ChatGPT.app (invalidates its code signature)
  --file PATH            Explicit target; may be repeated
  --json                 Print a JSON report
  --help                 Show this help

Requires macOS or Windows and Node.js 20 or newer. Test browser use before applying.`);
    return;
  }
  if (!["darwin", "win32"].includes(process.platform)) throw new Error("This patcher supports macOS and Windows only.");
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--file") {
      if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error("--file requires a path");
      i++;
    } else if (!["--check", "--restore", "--include-app-bundle", "--json"].includes(argv[i])) {
      throw new Error(`Unknown option: ${argv[i]}`);
    }
  }
  if (argv.includes("--check") && argv.includes("--restore")) throw new Error("Choose --check or --restore, not both.");
  const includeAppBundle = argv.includes("--include-app-bundle");
  if (includeAppBundle && process.platform !== "darwin") throw new Error("--include-app-bundle is available on macOS only.");
  const explicitFiles = argv
    .map((value, index) => (value === "--file" ? argv[index + 1] : null))
    .filter(Boolean);
  const asJson = argv.includes("--json");
  const mode = argv.includes("--restore")
    ? "restore"
    : argv.includes("--check")
      ? "check"
      : "apply";

  const targets = explicitFiles.length
    ? explicitFiles.map((file) => path.resolve(file))
    : discoverTargets({ includeAppBundle });

  if (mode === "apply" && targets.length) ensureControlFile();

  const results = targets.map((file) =>
    mode === "apply" ? applyTo(file) : mode === "restore" ? restoreFile(file) : { file, status: classify(file) },
  );

  const report = {
    mode,
    appVersion: appVersion(),
    controlFile: CONTROL_FILE,
    controlFileExists: fs.existsSync(CONTROL_FILE),
    includeAppBundle,
    results,
  };

  if (asJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    console.log(`Codex Desktop ${report.appVersion} — ${mode}`);
    if (mode !== "restore") {
      console.log(`control file: ${CONTROL_FILE} (${report.controlFileExists ? "present" : "missing"})`);
    }
    for (const result of results) {
      const suffix = result.backup ? `  [backup ${path.basename(result.backup)}]` : "";
      console.log(`  ${result.status.padEnd(16)} ${result.file}${suffix}`);
    }
  }

  if (!targets.length) {
    console.error("No browser service files found. Install/enable the browser plugin first, or use --file.");
    process.exitCode = 2;
  } else {
    const success = mode === "check" ? ["patched"]
      : mode === "apply" ? ["patched", "already"] : ["restored", "already-original"];
    if (results.some((result) => !success.includes(result.status))) process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
