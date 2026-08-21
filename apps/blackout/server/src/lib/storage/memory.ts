import type { StorageProvider } from "./types.js";

/**
 * Dev-only storage. Bytes live in-process; a server restart wipes everything.
 * Matches the existing dev pattern — broadcast runners shut down on restart
 * anyway, so there's no narration audio worth persisting across restarts.
 *
 * `getPublicUrl` returns a URL pointing at the server's /storage route so
 * browsers can fetch the bytes through the server itself.
 */
export class InMemoryStorage implements StorageProvider {
  private readonly store = new Map<string, { bytes: Buffer; contentType: string }>();
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async put(key: string, bytes: Buffer, contentType: string): Promise<void> {
    this.store.set(key, { bytes, contentType });
  }

  async getPublicUrl(key: string): Promise<string> {
    return `${this.baseUrl}/storage/${key}`;
  }

  async get(key: string): Promise<{ bytes: Buffer; contentType: string }> {
    const entry = this.store.get(key);
    if (!entry) throw new Error(`Storage key not found: ${key}`);
    return entry;
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}
