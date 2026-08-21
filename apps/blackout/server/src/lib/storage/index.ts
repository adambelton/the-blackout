import { InMemoryStorage } from "./memory.js";
import { R2Storage } from "./r2.js";
import type { StorageProvider } from "./types.js";

let _provider: StorageProvider | null = null;

/**
 * Returns the process-wide StorageProvider. R2 is used when the four
 * R2_* env vars are set; the normal development environment points
 * those credentials at the `blackout-dev` bucket. If they are absent,
 * the provider falls back to process memory. Explicit
 * `STORAGE_PROVIDER=memory` forces that test/isolated fallback even
 * when R2 is configured.
 */
export function getStorage(): StorageProvider {
  if (_provider) return _provider;

  const forceMemory = process.env.STORAGE_PROVIDER?.toLowerCase() === "memory";
  const hasR2 =
    !!process.env.R2_ACCOUNT_ID &&
    !!process.env.R2_ACCESS_KEY_ID &&
    !!process.env.R2_SECRET_ACCESS_KEY &&
    !!process.env.R2_BUCKET;

  if (!forceMemory && hasR2) {
    _provider = new R2Storage({
      accountId: process.env.R2_ACCOUNT_ID!,
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      bucket: process.env.R2_BUCKET!,
      publicBaseUrl: process.env.R2_PUBLIC_URL ?? null,
    });
    console.log(
      `[storage] using R2 (${process.env.R2_PUBLIC_URL ? "public-domain URLs" : "presigned URLs, 7d TTL"})`,
    );
  } else {
    const port = process.env.PORT || "4000";
    _provider = new InMemoryStorage(`http://localhost:${port}`);
    console.log(
      `[storage] using in-memory (${forceMemory ? "STORAGE_PROVIDER=memory" : "no R2 creds"})`,
    );
  }

  return _provider;
}

export type { StorageProvider } from "./types.js";
