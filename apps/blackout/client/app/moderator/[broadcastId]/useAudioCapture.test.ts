import { describe, expect, it, vi } from "vitest";
import { dispatchPcmFrame } from "./useAudioCapture";

interface FakeSocket {
  readyState: number;
  send: ReturnType<typeof vi.fn>;
}

function fakeSocket(readyState: number): FakeSocket {
  return { readyState, send: vi.fn() };
}

describe("dispatchPcmFrame", () => {
  it("sends the ArrayBuffer when the WS is OPEN", () => {
    const ws = fakeSocket(WebSocket.OPEN);
    const frame = new ArrayBuffer(64);
    const sent = dispatchPcmFrame(ws as unknown as WebSocket, frame);
    expect(sent).toBe(true);
    expect(ws.send).toHaveBeenCalledTimes(1);
    expect(ws.send).toHaveBeenCalledWith(frame);
  });

  it("drops the frame when the WS reference is null", () => {
    const sent = dispatchPcmFrame(null, new ArrayBuffer(64));
    expect(sent).toBe(false);
  });

  it.each([
    ["CONNECTING", WebSocket.CONNECTING],
    ["CLOSING", WebSocket.CLOSING],
    ["CLOSED", WebSocket.CLOSED],
  ])("drops the frame when the WS is %s", (_label, state) => {
    const ws = fakeSocket(state);
    const sent = dispatchPcmFrame(
      ws as unknown as WebSocket,
      new ArrayBuffer(64),
    );
    expect(sent).toBe(false);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("drops empty ArrayBuffers without calling send", () => {
    const ws = fakeSocket(WebSocket.OPEN);
    const sent = dispatchPcmFrame(
      ws as unknown as WebSocket,
      new ArrayBuffer(0),
    );
    expect(sent).toBe(false);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it.each([
    ["string", "hello"],
    ["number", 42],
    ["object", { not: "a buffer" }],
    ["null", null],
    ["undefined", undefined],
  ])("drops non-ArrayBuffer payload (%s)", (_label, payload) => {
    const ws = fakeSocket(WebSocket.OPEN);
    const sent = dispatchPcmFrame(ws as unknown as WebSocket, payload);
    expect(sent).toBe(false);
    expect(ws.send).not.toHaveBeenCalled();
  });
});
