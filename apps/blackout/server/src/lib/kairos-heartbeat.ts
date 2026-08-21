/**
 * Pure heartbeat helper for the Kairos WS subscription.
 *
 * Why this exists: the conductor's WS to Kairos went silently
 * half-open during the 2026-04-26 FA Cup semi-final — TCP-alive but
 * Kairos's restarted runtime had no record of the subscriber. TCP
 * keepalive alone takes minutes to detect; an application-level
 * ping/pong cycle catches it within `intervalMs + timeoutMs`.
 *
 * Lives in its own module so the contract can be unit-tested with
 * fake timers, no real WebSocket required.
 */

export interface HeartbeatHooks {
  /** Send a ping over the wire. The implementation typically calls
   * `socket.ping()` on the underlying `ws` library WebSocket. */
  ping: () => void;
  /** Force-terminate the underlying socket. Called when no pong has
   * arrived within `timeoutMs` of the most recent ping. The socket's
   * close handler is expected to handle the reconnect. */
  terminate: () => void;
}

export interface HeartbeatHandle {
  /** The caller invokes this when the underlying socket emits a pong
   * (or any equivalent liveness signal). Cancels the pending timeout. */
  onPong: () => void;
  /** Stop all timers. Idempotent. Called from the socket's close
   * handler and from the subscription's intentional-close path. */
  stop: () => void;
}

export interface HeartbeatOptions {
  /** How often a ping is sent. */
  intervalMs: number;
  /** How long after each ping the helper waits for a pong before
   * calling `terminate`. Should be smaller than `intervalMs` so the
   * timeout always resolves before the next ping fires. */
  timeoutMs: number;
}

export function startHeartbeat(
  hooks: HeartbeatHooks,
  opts: HeartbeatOptions,
): HeartbeatHandle {
  let interval: ReturnType<typeof setInterval> | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;

  const clearAll = (): void => {
    if (interval) clearInterval(interval);
    if (timeout) clearTimeout(timeout);
    interval = null;
    timeout = null;
  };

  interval = setInterval(() => {
    // Re-arm the timeout for this ping. If it fires before a pong
    // arrives, the connection is presumed half-open and `terminate`
    // forces reconnection.
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => {
      timeout = null;
      hooks.terminate();
    }, opts.timeoutMs);
    hooks.ping();
  }, opts.intervalMs);

  return {
    onPong: () => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
    },
    stop: clearAll,
  };
}
