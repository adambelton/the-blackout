import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiDelete, apiGet, apiPatch, apiPost } from "./api";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("typed api verbs", () => {
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("apiGet", () => {
    it("parses a JSON body on 200", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ id: "abc", name: "Match" }));
      const out = await apiGet<{ id: string; name: string }>("/broadcasts/abc");
      expect(out).toEqual({ id: "abc", name: "Match" });
    });

    it("sends credentials: include so the auth cookie rides along", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({}));
      await apiGet("/broadcasts");
      const init = fetchSpy.mock.calls[0]![1] as RequestInit;
      expect(init.credentials).toBe("include");
    });

    it("returns undefined on 204 No Content", async () => {
      fetchSpy.mockResolvedValueOnce(new Response(null, { status: 204 }));
      const out = await apiGet<void>("/broadcasts/abc/empty");
      expect(out).toBeUndefined();
    });
  });

  describe("error handling", () => {
    it("throws ApiError carrying status, server message, and parsed body", async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({ error: "Broadcast not found" }, 404),
      );
      await expect(apiGet("/broadcasts/missing")).rejects.toMatchObject({
        name: "ApiError",
        status: 404,
        message: "Broadcast not found",
        body: { error: "Broadcast not found" },
      });
    });

    it("falls back to HTTP <status> when the body has no error field", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ unrelated: 1 }, 502));
      const err = await apiGet("/broadcasts/abc/health").catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(502);
      expect((err as ApiError).message).toBe("HTTP 502");
    });

    it("falls back to HTTP <status> when the body is not JSON at all", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response("plain text body", { status: 500 }),
      );
      const err = await apiGet("/broadcasts/abc").catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).message).toBe("HTTP 500");
      expect((err as ApiError).body).toBeNull();
    });
  });

  describe("apiPost", () => {
    it("encodes the body as JSON and parses the response", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ id: "new" }, 201));
      const out = await apiPost<{ name: string }, { id: string }>(
        "/broadcasts",
        { name: "Match" },
      );
      expect(out).toEqual({ id: "new" });
      const init = fetchSpy.mock.calls[0]![1] as RequestInit;
      expect(init.method).toBe("POST");
      expect(init.body).toBe(JSON.stringify({ name: "Match" }));
      expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
        "application/json",
      );
    });

    it("propagates ApiError on non-2xx", async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({ error: "validation failed" }, 422),
      );
      await expect(
        apiPost("/broadcasts", { name: "" }),
      ).rejects.toMatchObject({
        status: 422,
        message: "validation failed",
      });
    });
  });

  describe("apiPatch", () => {
    it("uses PATCH and JSON-encodes the body", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ id: "abc", status: "live" }));
      const out = await apiPatch<{ status: string }, { id: string; status: string }>(
        "/broadcasts/abc",
        { status: "live" },
      );
      expect(out).toEqual({ id: "abc", status: "live" });
      const init = fetchSpy.mock.calls[0]![1] as RequestInit;
      expect(init.method).toBe("PATCH");
    });
  });

  describe("apiDelete", () => {
    it("uses DELETE and resolves to undefined on success", async () => {
      fetchSpy.mockResolvedValueOnce(new Response(null, { status: 204 }));
      const out = await apiDelete("/broadcasts/abc");
      expect(out).toBeUndefined();
      const init = fetchSpy.mock.calls[0]![1] as RequestInit;
      expect(init.method).toBe("DELETE");
    });

    it("throws ApiError on non-2xx", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ error: "forbidden" }, 403));
      await expect(apiDelete("/broadcasts/abc")).rejects.toMatchObject({
        status: 403,
        message: "forbidden",
      });
    });
  });

  describe("AbortSignal", () => {
    it("threads opts.signal into the fetch call", async () => {
      const ctrl = new AbortController();
      fetchSpy.mockResolvedValueOnce(jsonResponse({}));
      await apiGet("/broadcasts", { signal: ctrl.signal });
      const init = fetchSpy.mock.calls[0]![1] as RequestInit;
      expect(init.signal).toBe(ctrl.signal);
    });
  });
});
