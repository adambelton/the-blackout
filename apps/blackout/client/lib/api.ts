/**
 * Web → Blackout server fetch helpers.
 *
 * `apiFetch` is the low-level call: stamps `credentials: "include"`
 * so Better Auth's session cookie rides with cross-origin requests
 * (web on :3000 → server on :4000 in dev, distinct subdomains in
 * prod). The server's CORS config allows the origin and sets
 * `credentials: true`; the browser still needs the client to opt in
 * explicitly. Use this when you need direct Response access (file
 * uploads, manual streaming, custom error handling).
 *
 * The typed verbs below (`apiGet`/`apiPost`/`apiPatch`/`apiDelete`)
 * are the default — they handle JSON encoding, response parsing,
 * and error envelope unwrapping in one place. Migrating an inline
 * `apiFetch` site to the typed verb shrinks ~10 lines of boilerplate
 * to a single typed call and centralises the "how do we talk to the
 * server" decisions (body encoding, error shape, empty-body handling).
 *
 * Pass paths as relative (`"/broadcasts"`) — the helpers prepend
 * `API_URL`. For WebSocket URLs derive from `API_URL` separately.
 */
export const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${API_URL}${path}`, {
    ...init,
    credentials: "include",
  });
}

/**
 * Thrown when an API call returns a non-2xx response. Carries the
 * HTTP status, a human-readable message (the server's `error` field
 * when present, otherwise `HTTP <status>`), and the parsed body so
 * callers can branch on shape if they need to.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body: unknown = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function parseError(res: Response): Promise<ApiError> {
  const fallback = `HTTP ${res.status}`;
  const body = await res.json().catch(() => null);
  const message =
    body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
      ? (body as { error: string }).error
      : fallback;
  return new ApiError(res.status, message, body);
}

async function parseOk<T>(res: Response): Promise<T> {
  // Empty bodies (204 No Content; some DELETE handlers) return
  // undefined-as-T. Callers typing the verb as `apiDelete` or
  // `apiPost<TIn, void>` get the right shape; mistyped callers see
  // undefined at runtime where they expected a value.
  if (res.status === 204 || res.headers.get("content-length") === "0") {
    return undefined as T;
  }
  return res.json() as Promise<T>;
}

/**
 * Per-call options the typed verbs accept. Threaded through to the
 * underlying `fetch` so callers don't have to drop back to `apiFetch`
 * for common needs.
 */
export interface ApiCallOptions {
  /** AbortSignal for cancellation (component unmounts, dialog closes,
   * etc.). The verbs don't catch AbortError — caller decides whether
   * the abort is benign or worth surfacing. */
  signal?: AbortSignal;
}

export async function apiGet<T>(path: string, opts?: ApiCallOptions): Promise<T> {
  const res = await apiFetch(path, { signal: opts?.signal });
  if (!res.ok) throw await parseError(res);
  return parseOk<T>(res);
}

export async function apiPost<TIn, TOut = void>(
  path: string,
  body: TIn,
  opts?: ApiCallOptions,
): Promise<TOut> {
  const res = await apiFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: opts?.signal,
  });
  if (!res.ok) throw await parseError(res);
  return parseOk<TOut>(res);
}

export async function apiPatch<TIn, TOut = void>(
  path: string,
  body: TIn,
  opts?: ApiCallOptions,
): Promise<TOut> {
  const res = await apiFetch(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: opts?.signal,
  });
  if (!res.ok) throw await parseError(res);
  return parseOk<TOut>(res);
}

export async function apiDelete(path: string, opts?: ApiCallOptions): Promise<void> {
  const res = await apiFetch(path, { method: "DELETE", signal: opts?.signal });
  if (!res.ok) throw await parseError(res);
}
