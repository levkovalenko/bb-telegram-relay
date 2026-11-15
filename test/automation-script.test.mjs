// M4: canonical automation script (automation/biom-uptime-notify.py) logic.
//
// Runs the real python3 script against a fake `bb` binary on PATH:
//   - `bb uptime list --json`            -> fixture from BB_FAKE_UPTIME_FILE
//   - `bb telegram-relay broadcast ...`  -> args captured to a JSONL file
//   - `bb thread spawn ... --prompt-file -` -> args + stdin captured
// No real Telegram, no real automation: each test runs in a fresh temp dir
// with its own state file (or none).

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(repoRoot, "automation", "biom-uptime-notify.py");

// Fake `bb`: answers the subcommands the script uses, captures the rest.
const FAKE_BB = `#!/usr/bin/env node
import { readFileSync, appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const [cmd, sub] = args;
if (cmd === "uptime" && sub === "list") {
  process.stdout.write(readFileSync(process.env.BB_FAKE_UPTIME_FILE, "utf8"));
  process.exit(0);
}
if (cmd === "telegram-relay" && sub === "broadcast") {
  appendFileSync(process.env.BB_FAKE_CAPTURE, JSON.stringify({ cmd: "broadcast", args: args.slice(2) }) + "\\n");
  process.stdout.write("sent: 1\\nfailed: 0\\nlogId: 1\\n");
  process.exit(0);
}
if (cmd === "thread" && sub === "spawn") {
  const stdin = readFileSync(0, "utf8");
  appendFileSync(process.env.BB_FAKE_CAPTURE, JSON.stringify({ cmd: "thread-spawn", args: args.slice(2), stdin }) + "\\n");
  process.stdout.write("thr_fake_incident\\n");
  process.exit(0);
}
process.exit(0);
`;

const okCheck = (at, ms = 555) => ({ at, ok: true, status: 200, ms, error: null });
const badCheck = (at, error = "fetch failed") => ({ at, ok: false, status: null, ms: 110, error });
const site = (id, name, checks) => ({ id, name, url: `https://${name}/health`, checks });

/** Run the real script in a fresh temp cwd; return rc, captured bb calls, state. */
function runScript({ uptime, state = null } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), "auto-script-"));
  const bin = path.join(home, "bin");
  const work = path.join(home, "work");
  const uptimeFile = path.join(home, "uptime.json");
  const captureFile = path.join(home, "capture.jsonl");
  const stateFile = path.join(work, "biomregiona-uptime-state.json");
  mkdirSync(bin);
  mkdirSync(work);
  writeFileSync(uptimeFile, JSON.stringify(uptime));
  writeFileSync(path.join(bin, "bb"), FAKE_BB);
  chmodSync(path.join(bin, "bb"), 0o755);
  if (state !== null) writeFileSync(stateFile, JSON.stringify(state));

  const r = spawnSync("python3", [scriptPath], {
    cwd: work,
    encoding: "utf8",
    timeout: 30000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      BB_FAKE_UPTIME_FILE: uptimeFile,
      BB_FAKE_CAPTURE: captureFile,
      PROJECT_ID: "proj_test",
      MONITOR_THREAD: "thr_test",
    },
  });
  const calls = existsSync(captureFile)
    ? readFileSync(captureFile, "utf8").trim().split("\n").map((l) => JSON.parse(l))
    : [];
  const newState = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : null;
  rmSync(home, { recursive: true, force: true });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, calls, newState };
}

function argOf(call, flag) {
  const i = call.args.indexOf(flag);
  assert.ok(i !== -1, `missing ${flag} in: ${call.args.join(" ")}`);
  return call.args[i + 1];
}

test("first run (no state): broadcast «включён», no incident agent, state saved", () => {
  const r = runScript({ uptime: [site("a1", "site-a", [okCheck(1), okCheck(2)])] });
  assert.equal(r.status, 0);
  assert.equal(r.calls.length, 1, "exactly one bb call on first run");
  const b = r.calls[0];
  assert.equal(b.cmd, "broadcast");
  assert.match(argOf(b, "--title"), /включён/);
  assert.match(argOf(b, "--body"), /Всё работает/);
  assert.equal(argOf(b, "--channels"), "monitoring,incidents");
  assert.equal(argOf(b, "--level"), "info");
  assert.ok(!r.calls.some((c) => c.cmd === "thread-spawn"));
  assert.deepEqual(r.newState, { a1: "UP" });
});

test("UP -> DOWN: broadcast critical to monitoring,incidents + incident agent spawn", () => {
  const r = runScript({
    uptime: [site("a1", "site-a", [okCheck(1), badCheck(2), badCheck(3)])],
    state: { a1: "UP" },
  });
  assert.equal(r.status, 0);
  const b = r.calls.find((c) => c.cmd === "broadcast");
  assert.ok(b, "a broadcast must be sent");
  assert.match(argOf(b, "--title"), /⚠️/);
  assert.equal(argOf(b, "--channels"), "monitoring,incidents");
  assert.equal(argOf(b, "--level"), "critical");
  assert.match(argOf(b, "--body"), /site-a: DOWN/);

  const s = r.calls.find((c) => c.cmd === "thread-spawn");
  assert.ok(s, "incident agent must be spawned on DOWN");
  assert.equal(argOf(s, "--project"), "proj_test");
  assert.equal(argOf(s, "--parent-thread"), "thr_test");
  assert.match(s.stdin, /Сайт недоступен/);
  assert.match(s.stdin, /biom-e2e|site-a: DOWN/);
  assert.match(s.stdin, /telegram-relay broadcast .*--channels incidents --level critical/);
  assert.ok(!/push-notifications/.test(s.stdin), "prompt must not mention push-notifications");
  assert.deepEqual(r.newState, { a1: "DOWN" });
});

test("DOWN -> UP: broadcast info, no incident agent", () => {
  const r = runScript({
    uptime: [site("a1", "site-a", [badCheck(1), okCheck(2)])],
    state: { a1: "DOWN" },
  });
  assert.equal(r.status, 0);
  assert.equal(r.calls.length, 1, "one broadcast, no spawn");
  const b = r.calls[0];
  assert.equal(b.cmd, "broadcast");
  assert.match(argOf(b, "--title"), /✅/);
  assert.equal(argOf(b, "--channels"), "monitoring,incidents");
  assert.equal(argOf(b, "--level"), "info");
  assert.ok(!r.calls.some((c) => c.cmd === "thread-spawn"));
  assert.deepEqual(r.newState, { a1: "UP" });
});

test("no state change: silent tick, zero bb calls, state untouched", () => {
  const r = runScript({
    uptime: [site("a1", "site-a", [okCheck(1), okCheck(2)])],
    state: { a1: "UP" },
  });
  assert.equal(r.status, 0);
  assert.equal(r.calls.length, 0, "silent tick must call bb zero times");
  assert.deepEqual(r.newState, { a1: "UP" });
});
