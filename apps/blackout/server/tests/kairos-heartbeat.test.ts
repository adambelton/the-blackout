import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { startHeartbeat } from "../src/lib/kairos-heartbeat.js";

/**
 * Application-level heartbeat for the Kairos WS subscription.
 *
 * Real bug from 2026-04-26: Kairos restarted multiple times during
 * mid-broadcast edits. The conductor's TCP socket stayed in a
 * "connected" state after each restart, but Kairos's new runtime had
 * no record of the subscriber. The conductor's `onNarrative` callback
 * never fired for the rest of the broadcast — 1h 56m of total silence.
 *
 * Contract: ping on a fixed interval; if no pong arrives within the
 * timeout, force a terminate so the close handler reconnects.
 */
describe("startHeartbeat — application-level liveness", () => {
  it("calls ping() at the configured interval", (t) => {
    t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
    let pings = 0;
    const handle = startHeartbeat(
      { ping: () => pings++, terminate: () => assert.fail("must not terminate while pongs are timely") },
      { intervalMs: 1000, timeoutMs: 500 },
    );

    t.mock.timers.tick(1000);
    handle.onPong();
    t.mock.timers.tick(1000);
    handle.onPong();
    t.mock.timers.tick(1000);
    handle.onPong();

    assert.equal(pings, 3, "three intervals should have produced three pings");
    handle.stop();
  });

  it("calls terminate() when no pong arrives within timeoutMs of a ping", (t) => {
    t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
    let pings = 0;
    let terminates = 0;
    const handle = startHeartbeat(
      { ping: () => pings++, terminate: () => terminates++ },
      { intervalMs: 1000, timeoutMs: 500 },
    );

    // Ping fires at 1000ms.
    t.mock.timers.tick(1000);
    assert.equal(pings, 1);
    assert.equal(terminates, 0);

    // No pong; timeout fires 500ms later.
    t.mock.timers.tick(500);
    assert.equal(terminates, 1, "terminate must fire when no pong arrives within timeoutMs");
    handle.stop();
  });

  it("cancels the pending timeout when onPong arrives in time", (t) => {
    t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
    let pings = 0;
    let terminates = 0;
    const handle = startHeartbeat(
      { ping: () => pings++, terminate: () => terminates++ },
      { intervalMs: 1000, timeoutMs: 500 },
    );

    // Ping at 1000ms.
    t.mock.timers.tick(1000);
    assert.equal(pings, 1);

    // Pong arrives 100ms later — well inside the 500ms timeout.
    t.mock.timers.tick(100);
    handle.onPong();

    // Advance past the original timeout deadline; no terminate.
    t.mock.timers.tick(500);
    assert.equal(terminates, 0, "terminate must NOT fire when pong arrived in time");

    // Next ping fires at 2000ms (1000ms after the first).
    t.mock.timers.tick(400);
    assert.equal(pings, 2);
    handle.stop();
  });

  it("re-arms the timeout for each new ping (not just the first)", (t) => {
    t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
    let pings = 0;
    let terminates = 0;
    const handle = startHeartbeat(
      { ping: () => pings++, terminate: () => terminates++ },
      { intervalMs: 1000, timeoutMs: 500 },
    );

    // First ping at 1000ms, pong replies promptly.
    t.mock.timers.tick(1000);
    handle.onPong();

    // Second ping at 2000ms, no pong this time.
    t.mock.timers.tick(1000);
    assert.equal(pings, 2);
    assert.equal(terminates, 0);

    // Timeout for the second ping fires 500ms later.
    t.mock.timers.tick(500);
    assert.equal(terminates, 1, "terminate must fire on the SECOND ping's timeout, not just the first");
    handle.stop();
  });

  it("stop() prevents any further pings or terminates", (t) => {
    t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
    let pings = 0;
    let terminates = 0;
    const handle = startHeartbeat(
      { ping: () => pings++, terminate: () => terminates++ },
      { intervalMs: 1000, timeoutMs: 500 },
    );

    // Ping fires once.
    t.mock.timers.tick(1000);
    assert.equal(pings, 1);

    handle.stop();

    // Even with no pong, advancing past the timeout deadline produces
    // no terminate — stop() cleared the timer.
    t.mock.timers.tick(10_000);
    assert.equal(pings, 1, "no further pings after stop()");
    assert.equal(terminates, 0, "no terminate after stop()");
  });

  it("stop() is idempotent", (t) => {
    t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
    const handle = startHeartbeat(
      { ping: () => undefined, terminate: () => undefined },
      { intervalMs: 1000, timeoutMs: 500 },
    );
    handle.stop();
    handle.stop();
    handle.stop();
    // Reaching here without throwing is the assertion.
  });
});
