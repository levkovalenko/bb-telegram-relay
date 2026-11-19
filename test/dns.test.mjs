// DNS result order: on load the plugin pins the process-wide default DNS
// result order to ipv4first, because the host resolver serves a dead AAAA
// record for api.telegram.org and returns A/AAAA in a floating order — with
// the default (verbatim) order, fetch can try the dead IPv6 route first and
// every getUpdates times out.
//
// The fake host runs the built bundle in this test process, so the effect is
// observable via dns.getDefaultResultOrder(). Each test file runs in its own
// process, so the pin cannot leak into other suites; we still restore the
// default after each test.

import * as dns from "node:dns";
import test from "node:test";
import assert from "node:assert/strict";
import { installPlugin } from "./helpers.mjs";

test("pins the process DNS result order to ipv4first on load", async () => {
  // Baseline: Node's default is verbatim (since v17); without it the pin
  // would be indistinguishable from a pre-existing choice.
  assert.equal(dns.getDefaultResultOrder(), "verbatim");
  const { harness, cleanup } = await installPlugin();
  try {
    assert.equal(
      dns.getDefaultResultOrder(),
      "ipv4first",
      "load must pin the default DNS result order",
    );
    const pins = harness.inspection.logEntries.filter(
      (entry) =>
        entry.level === "info" &&
        /dns result order set to ipv4first/.test(entry.message),
    );
    assert.equal(pins.length, 1, "the pin is logged exactly once");
  } finally {
    await cleanup();
    dns.setDefaultResultOrder("verbatim");
  }
});

test("does not overwrite an explicitly set DNS result order", async () => {
  // Simulate an operator choice: the default is no longer verbatim.
  dns.setDefaultResultOrder("ipv6first");
  const { harness, cleanup } = await installPlugin();
  try {
    assert.equal(
      dns.getDefaultResultOrder(),
      "ipv6first",
      "an explicit operator choice must not be overwritten",
    );
    assert.ok(
      !harness.inspection.logEntries.some(
        (entry) => /dns result order set to ipv4first/.test(entry.message),
      ),
      "no pin log line when the default was already set",
    );
  } finally {
    await cleanup();
    dns.setDefaultResultOrder("verbatim");
  }
});
