// watchdog.test.ts — escalation state machine + integration: a stalled campaign
// (frozen events file) fires the ladder; a live one never does.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Watchdog, DEFAULT_WATCHDOG, eventsLiveness } from "../watchdog.js";

const MIN = 60_000;

test("escalation ladder: warn -> restart -> kill -> park (with cooldowns), recovery clears", () => {
  const w = new Watchdog({ ...DEFAULT_WATCHDOG, idleThresholdMs: 10 * MIN, stageCooldownMs: 5 * MIN });
  const t0 = Date.now();
  const live = (mtime: number, now = t0) => ({
    campaignId: "campaign:c_9", status: "running", running: true,
    queuedTasks: 1, leasedTasks: 0, eventsFile: "/tmp/e.jsonl", eventsMtimeMs: mtime,
  });

  assert.equal(w.evaluate(live(t0 - MIN), t0).action, "none");
  assert.equal(w.evaluate(live(t0 - MIN), t0 + 11 * MIN).action, "warn");
  assert.equal(w.evaluate(live(t0 - MIN), t0 + 17 * MIN).action, "restart");
  assert.equal(w.evaluate(live(t0 - MIN), t0 + 23 * MIN).action, "kill");
  const park = w.evaluate(live(t0 - MIN), t0 + 29 * MIN);
  assert.equal(park.action, "park");
  assert.match(park.reason, /human review/);
  // recovery after non-terminal stages clears the incident
  const w2 = new Watchdog({ ...DEFAULT_WATCHDOG, idleThresholdMs: 10 * MIN, stageCooldownMs: 5 * MIN });
  w2.evaluate(live(t0 - MIN), t0);
  w2.evaluate(live(t0 - 11 * MIN), t0 + 11 * MIN); // warn
  assert.equal(w2.evaluate(live(t0 + 20 * MIN), t0 + 20 * MIN).action, "none", "events flowed again");
  assert.equal(w2.state.incidents["campaign:c_9"], undefined, "incident cleared after recovery");
  // PARKED stays parked (human review owns it) even if events resume
  assert.equal(w.evaluate(live(t0 + 35 * MIN), t0 + 35 * MIN).action, "none");
  assert.equal(w.state.incidents["campaign:c_9"]?.stage, "parked", "parked is sticky — human decides");
});

test("no action without pending work; no action while events flow", () => {
  const w = new Watchdog({ ...DEFAULT_WATCHDOG, idleThresholdMs: 10 * MIN, stageCooldownMs: 5 * MIN });
  const now = Date.now();
  const idle = { campaignId: "c", status: "running", running: true, queuedTasks: 0, leasedTasks: 0, eventsFile: "/x", eventsMtimeMs: now - 60 * MIN };
  assert.equal(w.evaluate(idle, now).action, "none", "running but nothing queued — not an incident");
  const busy = { ...idle, queuedTasks: 3, eventsMtimeMs: now - 30_000 };
  assert.equal(w.evaluate(busy, now).action, "none", "events flowing");
  const oldButDone = { ...idle, queuedTasks: 0, leasedTasks: 0, eventsMtimeMs: now - 60 * MIN };
  assert.equal(w.evaluate(oldButDone, now).action, "none");
});

test("circuit breaker: 3 restarts/hour ⇒ park instead of flapping", () => {
  const w = new Watchdog({ ...DEFAULT_WATCHDOG, idleThresholdMs: MIN, stageCooldownMs: 0 });
  const now = Date.now();
  w.state.incidents["campaign:c_1"] = { lastEventAt: now - 2 * MIN, stage: "restarting", stageSince: now, restarts: [now, now - 1000, now - 2000] };
  const d = w.evaluate({ campaignId: "campaign:c_1", status: "running", running: true, queuedTasks: 1, leasedTasks: 0, eventsFile: "/x", eventsMtimeMs: now - 2 * MIN }, now);
  assert.equal(d.action, "park");
  assert.match(d.reason, /circuit breaker/);
});

test("eventsLiveness reads mtime from the campaign workspace (integration with files)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wd-"));
  const ws = path.join(tmp, "c_1-abc");
  fs.mkdirSync(path.join(ws, "state"), { recursive: true });
  const f = path.join(ws, "state", "events.jsonl");
  fs.writeFileSync(f, "{}\n");
  const before = eventsLiveness(tmp, "campaign:c_1", ws);
  assert.ok(before.mtimeMs > 0);
  assert.equal(before.eventsFile, f);
  const missing = eventsLiveness(tmp, "campaign:c_2", path.join(tmp, "c_2-nope"));
  assert.equal(missing.mtimeMs, 0, "missing file ⇒ 0 (old mtime) — watchdog escalates");
});
