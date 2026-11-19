// M4: canonical automation script (automation/biom-uptime-notify.py) logic.
//
// Runs the real python3 script against a fake `bb` binary on PATH:
//   - `bb uptime list --json`            -> fixture from BB_FAKE_UPTIME_FILE
//   - `bb telegram-relay broadcast ...`  -> args captured to a JSONL file
//     (BB_FAKE_BROADCAST_FAIL_TIMES makes the first N broadcasts fail,
//      counted in a sidecar file, to exercise the alert retry)
//   - `bb thread spawn ... --prompt-file -` -> args + stdin captured
// Plus: DOWN-window dedupe (one alert per window), the non-blocking lock
// (held lock -> quiet exit 0), the one-retry alert budget, and cross-tick
// retry of an undelivered alert (alert_sent_at = null).
// No real Telegram, no real automation: each test runs in a fresh temp dir
// with its own state file (or none).

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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
  // Optional failure mode: the first BB_FAKE_BROADCAST_FAIL_TIMES calls fail
  // (the counter lives in a sidecar file so attempts are counted across
  // separate invocations, like real separate runs).
  const failTimes = parseInt(process.env.BB_FAKE_BROADCAST_FAIL_TIMES || "0", 10);
  const countFile = process.env.BB_FAKE_CAPTURE + ".failcount";
  let count = 0;
  try {
    count = parseInt(readFileSync(countFile, "utf8") || "0", 10);
  } catch {}
  if (count < failTimes) {
    appendFileSync(countFile, String(count + 1));
    appendFileSync(process.env.BB_FAKE_CAPTURE, JSON.stringify({ cmd: "broadcast-failed", args: args.slice(2) }) + "\\n");
    process.stderr.write("fake broadcast failure (attempt " + (count + 1) + ")\\n");
    process.exit(1);
  }
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

/** Run the real script in a fresh temp cwd; return rc, captured bb calls, state.
 *  `beforeRun` (async) gets the temp paths — used to hold the lock before the
 *  script starts. */
async function runScript({ uptime, state = null, extraEnv = {}, beforeRun = null } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), "auto-script-"));
  const bin = path.join(home, "bin");
  const work = path.join(home, "work");
  const uptimeFile = path.join(home, "uptime.json");
  const captureFile = path.join(home, "capture.jsonl");
  const stateFile = path.join(work, "biomregiona-uptime-state.json");
  const lockFile = path.join(work, "biomregiona-uptime-state.json.lock");
  mkdirSync(bin);
  mkdirSync(work);
  writeFileSync(uptimeFile, JSON.stringify(uptime));
  writeFileSync(path.join(bin, "bb"), FAKE_BB);
  chmodSync(path.join(bin, "bb"), 0o755);
  if (state !== null) writeFileSync(stateFile, JSON.stringify(state));

  if (beforeRun) await beforeRun({ home, bin, work, uptimeFile, captureFile, stateFile, lockFile });

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
      ...extraEnv,
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

test("first run (no state): broadcast «включён», no incident agent, state saved", async () => {
  const r = await runScript({ uptime: [site("a1", "site-a", [okCheck(1), okCheck(2)])] });
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

test("UP -> DOWN: broadcast critical to monitoring,incidents + incident agent spawn", async () => {
  const startedAt = Math.floor(Date.now() / 1000);
  const r = await runScript({
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
  // DOWN state is now a "window" object: the delivered alert is stamped and
  // the agent marked spawned, so the next tick dedupes both.
  assert.equal(r.newState.a1.status, "DOWN");
  assert.equal(typeof r.newState.a1.alert_sent_at, "number");
  assert.ok(
    r.newState.a1.alert_sent_at >= startedAt &&
      r.newState.a1.alert_sent_at <= Math.floor(Date.now() / 1000),
    "alert_sent_at must stamp the delivered alert",
  );
  assert.equal(r.newState.a1.agent_spawned, true);
});

test("DOWN -> UP: broadcast info, no incident agent", async () => {
  const r = await runScript({
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

test("no state change: silent tick, zero bb calls, state untouched", async () => {
  const r = await runScript({
    uptime: [site("a1", "site-a", [okCheck(1), okCheck(2)])],
    state: { a1: "UP" },
  });
  assert.equal(r.status, 0);
  assert.equal(r.calls.length, 0, "silent tick must call bb zero times");
  assert.deepEqual(r.newState, { a1: "UP" });
});

test("DOWN with INCIDENT_* set: incident agent spawn carries --provider/--model/--reasoning-level", async () => {
  const r = await runScript({
    uptime: [site("a1", "site-a", [okCheck(1), badCheck(2), badCheck(3)])],
    state: { a1: "UP" },
    extraEnv: {
      INCIDENT_PROVIDER: "acp-opencode",
      INCIDENT_MODEL: "11m/qwen3.8-27b-8fp-mtp-3",
      INCIDENT_REASONING: "high",
    },
  });
  assert.equal(r.status, 0);
  const s = r.calls.find((c) => c.cmd === "thread-spawn");
  assert.ok(s, "incident agent must be spawned on DOWN");
  assert.equal(argOf(s, "--provider"), "acp-opencode");
  assert.equal(argOf(s, "--model"), "11m/qwen3.8-27b-8fp-mtp-3");
  assert.equal(argOf(s, "--reasoning-level"), "high");
  assert.equal(argOf(s, "--project"), "proj_test");
  assert.equal(argOf(s, "--parent-thread"), "thr_test");
});

test("DOWN with empty INCIDENT_* env: spawn keeps default (no --provider/--model/--reasoning-level)", async () => {
  const r = await runScript({
    uptime: [site("a1", "site-a", [okCheck(1), badCheck(2), badCheck(3)])],
    state: { a1: "UP" },
    extraEnv: { INCIDENT_PROVIDER: "", INCIDENT_MODEL: "", INCIDENT_REASONING: "" },
  });
  assert.equal(r.status, 0);
  const s = r.calls.find((c) => c.cmd === "thread-spawn");
  assert.ok(s, "incident agent must be spawned on DOWN");
  assert.ok(!s.args.includes("--provider"), "no --provider when INCIDENT_PROVIDER is empty");
  assert.ok(!s.args.includes("--model"), "no --model when INCIDENT_MODEL is empty");
  assert.ok(!s.args.includes("--reasoning-level"), "no --reasoning-level when INCIDENT_REASONING is empty");
});

test("still DOWN, alert delivered <15min ago: no repeated alert, no re-spawn, exit 0", async () => {
  const fresh = Math.floor(Date.now() / 1000) - 60; // one minute ago
  const r = await runScript({
    uptime: [site("a1", "site-a", [okCheck(1), badCheck(2), badCheck(3)])],
    state: { a1: { status: "DOWN", alert_sent_at: fresh, agent_spawned: true } },
  });
  assert.equal(r.status, 0);
  assert.equal(r.calls.length, 0, "fresh window: zero bb calls (dedupe)");
  assert.match(r.stderr, /skipping repeated alert/);
  assert.deepEqual(r.newState, {
    a1: { status: "DOWN", alert_sent_at: fresh, agent_spawned: true },
  });
});

test("still DOWN, last alert >15min ago: re-alert once, no agent re-spawn", async () => {
  const stale = Math.floor(Date.now() / 1000) - 16 * 60;
  const r = await runScript({
    uptime: [site("a1", "site-a", [okCheck(1), badCheck(2), badCheck(3)])],
    state: { a1: { status: "DOWN", alert_sent_at: stale, agent_spawned: true } },
  });
  assert.equal(r.status, 0);
  assert.equal(r.calls.filter((c) => c.cmd === "broadcast").length, 1, "exactly one re-alert");
  const b = r.calls.find((c) => c.cmd === "broadcast");
  assert.match(argOf(b, "--title"), /⚠️/);
  assert.equal(argOf(b, "--level"), "critical");
  assert.ok(!r.calls.some((c) => c.cmd === "thread-spawn"), "agent already spawned: no re-spawn");
  assert.equal(r.newState.a1.status, "DOWN");
  assert.equal(typeof r.newState.a1.alert_sent_at, "number");
  assert.ok(r.newState.a1.alert_sent_at > stale, "alert_sent_at refreshed on re-alert");
  assert.equal(r.newState.a1.agent_spawned, true);
});

test("lock held by another run: quiet exit 0, zero bb calls", async () => {
  let holder = null;
  const r = await runScript({
    uptime: [site("a1", "site-a", [okCheck(1), badCheck(2), badCheck(3)])],
    state: { a1: "UP" },
    beforeRun: async ({ lockFile }) => {
      // A live rival process holds the flock, like a previous tick whose
      // slow broadcast is still running. (A SIGKILLed run releases the lock:
      // the kernel drops flock on process death.)
      holder = spawn(
        "python3",
        [
          "-c",
          `import fcntl, os, time\nfd = os.open(${JSON.stringify(lockFile)}, os.O_CREAT | os.O_RDWR)\nfcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)\ntime.sleep(60)\n`,
        ],
        { stdio: "ignore" },
      );
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.equal(holder.exitCode, null, "lock holder must still be alive");
    },
  });
  try {
    assert.equal(r.status, 0, "held lock -> quiet exit 0");
    assert.equal(r.calls.length, 0, "no bb calls behind the lock");
  } finally {
    if (holder) holder.kill("SIGKILL");
  }
});

test("first broadcast fails: one retry after backoff, alert delivered, state stamped", async () => {
  const r = await runScript({
    uptime: [site("a1", "site-a", [okCheck(1), badCheck(2), badCheck(3)])],
    state: { a1: "UP" },
    extraEnv: { BB_FAKE_BROADCAST_FAIL_TIMES: "1", BIOM_RETRY_BACKOFF_SECS: "1" },
  });
  assert.equal(r.status, 0);
  assert.equal(r.calls.filter((c) => c.cmd === "broadcast-failed").length, 1, "first attempt fails");
  assert.equal(r.calls.filter((c) => c.cmd === "broadcast").length, 1, "the retry delivers");
  assert.equal(r.calls.filter((c) => c.cmd === "thread-spawn").length, 1, "agent spawned once");
  assert.match(r.stderr, /retry in 1s/);
  assert.equal(r.newState.a1.status, "DOWN");
  assert.equal(typeof r.newState.a1.alert_sent_at, "number", "alert confirmed in state");
  assert.equal(r.newState.a1.agent_spawned, true);
});

test("broadcast keeps failing: rc 1, window persisted WITHOUT alert_sent_at (next tick retries)", async () => {
  const r = await runScript({
    uptime: [site("a1", "site-a", [okCheck(1), badCheck(2), badCheck(3)])],
    state: { a1: "UP" },
    extraEnv: { BB_FAKE_BROADCAST_FAIL_TIMES: "99", BIOM_RETRY_BACKOFF_SECS: "1" },
  });
  assert.equal(r.status, 1, "undelivered alert -> failed run, visible in the automation history");
  assert.equal(r.calls.filter((c) => c.cmd === "broadcast-failed").length, 2, "attempt + exactly one retry");
  assert.ok(!r.calls.some((c) => c.cmd === "broadcast"), "no successful delivery");
  assert.ok(!r.calls.some((c) => c.cmd === "thread-spawn"), "agent only after a delivered alert");
  assert.equal(r.newState.a1.status, "DOWN", "window persisted BEFORE the first attempt");
  assert.equal(r.newState.a1.alert_sent_at, null, "no confirmation until delivered");
  assert.equal(r.newState.a1.agent_spawned, false);
});

test("cross-tick: DOWN window with undelivered alert (alert_sent_at null) re-delivers and spawns", async () => {
  const r = await runScript({
    uptime: [site("a1", "site-a", [okCheck(1), badCheck(2), badCheck(3)])],
    state: { a1: { status: "DOWN", alert_sent_at: null, agent_spawned: false } },
  });
  assert.equal(r.status, 0);
  assert.equal(r.calls.filter((c) => c.cmd === "broadcast").length, 1, "alert delivered on the retry tick");
  assert.equal(r.calls.filter((c) => c.cmd === "thread-spawn").length, 1, "agent spawned (previous tick was cut before spawn)");
  assert.equal(r.newState.a1.status, "DOWN");
  assert.equal(typeof r.newState.a1.alert_sent_at, "number", "alert confirmed");
  assert.equal(r.newState.a1.agent_spawned, true);
});
