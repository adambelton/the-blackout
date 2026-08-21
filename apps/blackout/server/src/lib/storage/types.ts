/**
 * StorageProvider — abstracts where broadcast audio lives.
 *
 * The RoomConductor synthesises a narration's audio on arrival from Kairos,
 * calls `put` to persist it, then embeds the URL returned by `getPublicUrl`
 * in the `play` / `preload` WS cues sent to matchroom and moderator clients.
 *
 * Two implementations:
 *   - InMemoryStorage (dev) — bytes live in a Map, `getPublicUrl` returns a
 *     local server URL hitting the /storage/:path route.
 *   - R2Storage (prod)     — bytes live in Cloudflare R2, `getPublicUrl`
 *     returns a short-lived signed URL that Cloudflare serves directly.
 *
 * Keys are slash-delimited strings; the canonical shape for narration audio
 * is `broadcasts/<broadcastId>/narrations/<narrationId>.mp3`.
 */
export interface StorageProvider {
  /** Persist bytes under the given key. Overwrites if the key already exists. */
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;

  /**
   * Resolve a URL an HTTP client can fetch to get the bytes. For R2 this
   * is a signed URL with a short TTL; regenerate before embedding in a
   * WS cue to keep the expiry in the future when a late joiner arrives.
   */
  getPublicUrl(key: string): Promise<string>;

  /** Fetch the raw bytes. Used by the in-memory dev path's /storage route. */
  get(key: string): Promise<{ bytes: Buffer; contentType: string }>;

  /** Remove an object. */
  delete(key: string): Promise<void>;
}
