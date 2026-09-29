import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildHelperSource, patchSource, restoreFile } from "../codex-browser-fix.mjs";

const script = fileURLToPath(new URL("../codex-browser-fix.mjs", import.meta.url));
const windowsLauncher = fileURLToPath(new URL("../install-windows.cmd", import.meta.url));
const fixture = "function fixture(){return new Client(r,this.clientApi,()=>metadata(this.runtime),this.turnEndedTracker,policy)}";
const hash = (s) => crypto.createHash("sha256").update(s).digest("hex");
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-fix-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("patching is selective, unambiguous, idempotent and syntactically valid", () => {
  assert.equal(patchSource("export const unrelated = true;").status, "no-match");
  assert.equal(patchSource(fixture + fixture).status, "ambiguous");
  const patched = patchSource(fixture);
  assert.equal(patched.status, "patched");
  assert.equal(patchSource(patched.out).status, "already");
  const result = spawnSync(process.execPath, ["--input-type=module", "--check"], { input: patched.out, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("local policy only overrides supported, stable extension sessions", async (t) => {
  const dir = temporary(t);
  const control = path.join(dir, "control.json");
  const source = buildHelperSource(control) + "\nexport default __cppMacIdReader;";
  const { default: reader } = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
  const validInfo = () => ({ type: "extension", family: "chrome", agentRequestHeaderEnabled: false,
    metadata: { extensionId: "hehggadaopoacecdllhhajmbjkdcmajg", extensionInstanceId: "instance" } });
  const turn = { session_id: "session", turn_id: "turn" };
  const cases = [
    { name: "supported Chrome", expected: true },
    { name: "supported Edge", expected: true, mutate: (info) => { info.family = "edge"; info.metadata.extensionId = "odlomjlbamekndcpllcnffbgeohgkmjh"; } },
    { name: "non-extension", mutate: (info) => { info.type = "iab"; } },
    { name: "unknown extension", mutate: (info) => { info.metadata.extensionId = "unknown"; } },
    { name: "missing instance", mutate: (info) => { delete info.metadata.extensionInstanceId; } },
    { name: "nonboolean capability", mutate: (info) => { info.agentRequestHeaderEnabled = "true"; } },
    { name: "disabled control", control: { schema: 1, requireIdentification: false } },
    { name: "unknown schema", control: { schema: 2, requireIdentification: true } },
    { name: "missing control", missing: true },
    { name: "malformed control", raw: "{" },
    { name: "oversized control", raw: " ".repeat(4097) },
    { name: "ended turn", metadata: () => null },
    { name: "turn changes during read", changedTurn: true },
    { name: "client changes during read", changedClient: true },
  ];
  for (const c of cases) {
    await t.test(c.name, async () => {
      fs.rmSync(control, { force: true });
      if (!c.missing) fs.writeFileSync(control, c.raw ?? JSON.stringify(c.control ?? { schema: 1, requireIdentification: true }));
      const info = validInfo();
      c.mutate?.(info);
      const client = { clientInfo: info };
      let calls = 0, fallbackCalls = 0;
      const metadata = c.metadata ?? (() => {
        calls++;
        if (calls > 1 && c.changedClient) client.clientInfo = validInfo();
        return calls > 1 && c.changedTurn ? { ...turn, turn_id: "another" } : turn;
      });
      const result = await reader(metadata, () => { fallbackCalls++; return "vendor"; }).call(client);
      assert.equal(result, c.expected ?? "vendor");
      assert.equal(fallbackCalls, c.expected ? 0 : 1);
    });
  }
});

test("restore requires the exact original and unchanged patched content", (t) => {
  const dir = temporary(t);
  const file = path.join(dir, "browser-service.mjs");
  const backup = path.join(dir, "original-browser-service.mjs");
  const patched = patchSource(fixture).out;
  fs.writeFileSync(file, patched);
  fs.writeFileSync(backup, fixture);
  const state = { entries: [{ file, backup, sha256Before: hash(fixture), sha256After: hash(patched) }] };
  assert.equal(restoreFile(file, { entries: [] }, dir).status, "no-state");
  fs.writeFileSync(backup, "wrong version");
  assert.equal(restoreFile(file, state, dir).status, "no-matching-backup");
  assert.equal(fs.readFileSync(file, "utf8"), patched);
  fs.writeFileSync(backup, fixture);
  fs.appendFileSync(file, "\n// later edit");
  assert.equal(restoreFile(file, state, dir).status, "modified-since-patch");
  fs.writeFileSync(file, patched);
  assert.equal(restoreFile(file, state, dir).status, "restored");
  assert.equal(fs.readFileSync(file, "utf8"), fixture);
  assert.equal(restoreFile(file, state, dir).status, "already-original");
});

test("CLI reports missing targets and rejects invalid arguments", { skip: !["darwin", "win32"].includes(process.platform) }, (t) => {
  const dir = temporary(t);
  const run = (...args) => spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8", env: { ...process.env, CODEX_HOME: dir, LOCALAPPDATA: dir },
  });
  const empty = run("--check", "--json");
  assert.equal(empty.status, 2);
  assert.deepEqual(JSON.parse(empty.stdout).results, []);
  assert.equal(run("--file").status, 2);
  assert.equal(run("--unknown").status, 2);
  assert.equal(run("--restore", "--check").status, 2);
  if (process.platform === "win32") assert.equal(run("--include-app-bundle").status, 2);
  assert.equal(run("--help").status, 0);
});

test("CLI discovers user-cache browser services and completes apply/check/restore", { skip: !["darwin", "win32"].includes(process.platform) }, (t) => {
  const dir = temporary(t);
  const localAppData = path.join(dir, "local-app-data");
  const service = path.join(dir, "plugins", "cache", "openai-bundled", "chrome", "test-version", "scripts", "browser-service.mjs");
  fs.mkdirSync(path.dirname(service), { recursive: true });
  fs.writeFileSync(service, fixture);
  const runtimeService = path.join(localAppData, "OpenAI", "Codex", "runtimes", "cua_node", "test-version", "bin", "node_modules", "@oai", "browser-desktop", "scripts", "browser-service.mjs");
  if (process.platform === "win32") {
    fs.mkdirSync(path.dirname(runtimeService), { recursive: true });
    fs.writeFileSync(runtimeService, fixture);
  }
  const run = (...args) => spawnSync(process.execPath, [script, ...args, "--json"], {
    encoding: "utf8", env: { ...process.env, CODEX_HOME: dir, HOME: dir, USERPROFILE: dir, LOCALAPPDATA: localAppData },
  });
  const before = run("--check");
  assert.equal(before.status, 1, before.stderr);
  assert.equal(JSON.parse(before.stdout).results[0].status, "unpatched");
  const applied = run();
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(JSON.parse(applied.stdout).results[0].status, "patched");
  if (process.platform === "win32") assert.equal(JSON.parse(applied.stdout).results.length, 2);
  assert.equal(run("--check").status, 0);
  const restored = run("--restore");
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(fs.readFileSync(service, "utf8"), fixture);
  if (process.platform === "win32") assert.equal(fs.readFileSync(runtimeService, "utf8"), fixture);
});

test("Windows launcher works from another working directory", { skip: process.platform !== "win32" }, (t) => {
  const dir = temporary(t);
  const bundle = path.join(dir, "extracted folder with spaces");
  const codexHome = path.join(dir, "Codex cache");
  fs.mkdirSync(bundle);
  fs.copyFileSync(script, path.join(bundle, path.basename(script)));
  fs.copyFileSync(windowsLauncher, path.join(bundle, path.basename(windowsLauncher)));
  const service = path.join(codexHome, "plugins", "cache", "openai-bundled", "chrome", "test-version", "scripts", "browser-service.mjs");
  fs.mkdirSync(path.dirname(service), { recursive: true });
  fs.writeFileSync(service, fixture);
  const env = { ...process.env, CODEX_HOME: codexHome, HOME: dir, USERPROFILE: dir,
    LOCALAPPDATA: path.join(dir, "local-app-data"), CODEX_FIX_NO_PAUSE: "1",
    PATH: `${path.dirname(process.execPath)};${process.env.PATH ?? ""}` };
  const run = (...args) => spawnSync(process.env.ComSpec ?? "cmd.exe", ["/c", path.join(bundle, path.basename(windowsLauncher)), ...args], {
    cwd: dir, env, encoding: "utf8",
  });
  const applied = run();
  assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  assert.match(applied.stdout, /Success\./);
  assert.equal(patchSource(fs.readFileSync(service, "utf8")).status, "already");
  const restored = run("--restore");
  assert.equal(restored.status, 0, restored.stdout + restored.stderr);
  assert.equal(fs.readFileSync(service, "utf8"), fixture);
});
