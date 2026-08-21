/**
 * Auto-reconnecting WebSocket hook.
 *
 * Both the matchroom and moderator pages had near-identical ~140-line
 * WS subsystems: same exponential-backoff (1.5s → 3s → 6s, capped at
 * 10s, resets on successful open), same late-joiner snapshot pattern,
 * same try/catch envelope parsing, same onclose retry. They drifted
 * (slightly) every time one was edited without the other. This hook
 * is the single shape both pages can share.
 *
 * The page provides:
 *   - The URL to connect to (full ws:// or wss:// URL).
 *   - `onMessage(event)` — fires on every received frame. The page
 *     parses `event.data` itself (envelope shape varies per surface)
 *     and dispatches into its discriminated-union handler.
 *   - `onOpen(ws)` — fires after every successful connect, including
 *     reconnects. The page uses this to trigger backfill (matchroom)
 *     or resume capture (moderator). The current WS instance is
 *     passed so the page can `ws.send(...)` from inside.
 *   - `onError(event)` — optional; for surfacing connection-level
 *     failures.
 *   - `enabled` — false suspends the connection without unmounting.
 *
 * The hook returns:
 *   - `status` — observable connection state for UI rendering.
 *   - `send(data)` — type-safe send that no-ops when the socket
 *     isn't open. Returns true on actual send.
 */

import { useEffect, useRef, useState } from "react";

export type WsStatus = "connecting" | "open" | "closed" | "error";

export interface UseReconnectingWebSocketOptions {
  onMessage?: (event: MessageEvent) => void;
  onOpen?: (ws: WebSocket) => void;
  onError?: (event: Event) => void;
  enabled?: boolean;
}

export interface UseReconnectingWebSocketResult {
  status: WsStatus;
  send: (data: ArrayBuffer | ArrayBufferView | Blob | string) => boolean;
}

export const RECONNECT_BASE_MS = 1_500;
export const RECONNECT_CAP_MS = 10_000;

export function reconnectDelay(attempt: number): number {
  return Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_CAP_MS);
}

export function useReconnectingWebSocket(
  url: string | null,
  options: UseReconnectingWebSocketOptions = {},
): UseReconnectingWebSocketResult {
  const { onMessage, onOpen, onError, enabled = true } = options;
  const [status, setStatus] = useState<WsStatus>("closed");
  const wsRef = useRef<WebSocket | null>(null);

  // Stash callbacks in refs so the connect effect doesn't re-run when
  // the parent recreates these functions on every render. Without the
  // refs, any inline or uncached useCallback in the caller would tear
  // and rebuild the socket on every render — not a bug, but a
  // reconnect storm. The effect only re-runs when `url` or `enabled`
  // changes; callbacks are always current through the ref.
  const onMessageRef = useRef(onMessage);
  const onOpenRef = useRef(onOpen);
  const onErrorRef = useRef(onError);
  onMessageRef.current = onMessage;
  onOpenRef.current = onOpen;
  onErrorRef.current = onError;

  useEffect(() => {
    if (!enabled || !url) {
      setStatus("closed");
      return;
    }

    let mounted = true;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const connect = () => {
      if (!mounted) return;
      ws = new WebSocket(url);
      wsRef.current = ws;
      setStatus("connecting");

      ws.onopen = () => {
        attempt = 0;
        setStatus("open");
        if (ws) onOpenRef.current?.(ws);
      };
      ws.onerror = (event) => {
        setStatus("error");
        onErrorRef.current?.(event);
      };
      ws.onclose = () => {
        wsRef.current = null;
        if (!mounted) return;
        setStatus("closed");
        const delay = reconnectDelay(attempt);
        attempt++;
        reconnectTimer = setTimeout(connect, delay);
      };
      ws.onmessage = (event) => {
        onMessageRef.current?.(event);
      };
    };

    connect();

    return () => {
      mounted = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) {
        try {
          ws.close();
        } catch {
          // The socket may already be closing; ignore.
        }
      }
      wsRef.current = null;
    };
  }, [url, enabled]);

  const send = (data: ArrayBuffer | ArrayBufferView | Blob | string): boolean => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(data);
    return true;
  };

  return { status, send };
}
