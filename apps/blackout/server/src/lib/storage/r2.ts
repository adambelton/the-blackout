import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { StorageProvider } from "./types.js";

/**
 * Cloudflare R2 storage via the S3-compatible API.
 *
 * URL strategy: when `publicBaseUrl` is set, `getPublicUrl` returns a
 * permanent `${publicBaseUrl}/${key}` URL — served directly from R2 via
 * Cloudflare's edge cache, never expires, no server bandwidth cost.
 * This is the production path: every R2 bucket has public access
 * enabled (either an `r2.dev` URL or a custom domain) and the env var
 * `R2_PUBLIC_URL` carries the base.
 *
 * Fallback: when `publicBaseUrl` is unset, `getPublicUrl` returns a
 * presigned URL with `signedUrlTtlSeconds` expiry (default 7 days —
 * the realistic ceiling of any matchroom session, including paused
 * replays). Used for buckets that don't have public access enabled,
 * primarily test environments.
 */
export class R2Storage implements StorageProvider {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly signedUrlTtlSeconds: number;
  private readonly publicBaseUrl: string | null;

  constructor(opts: {
    accountId: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
    publicBaseUrl?: string | null;
    signedUrlTtlSeconds?: number;
  }) {
    this.client = new S3Client({
      region: "auto",
      endpoint: `https://${opts.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: opts.accessKeyId,
        secretAccessKey: opts.secretAccessKey,
      },
    });
    this.bucket = opts.bucket;
    // 7 days — AWS S3 max for presigned URLs and a comfortable
    // ceiling for any reasonable matchroom session (live or paused
    // replay). Falls back to this only when publicBaseUrl is unset.
    this.signedUrlTtlSeconds = opts.signedUrlTtlSeconds ?? 7 * 24 * 60 * 60;
    this.publicBaseUrl = opts.publicBaseUrl?.replace(/\/$/, "") ?? null;
  }

  async put(key: string, bytes: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
        ContentType: contentType,
      }),
    );
  }

  async getPublicUrl(key: string): Promise<string> {
    if (this.publicBaseUrl) {
      return `${this.publicBaseUrl}/${key}`;
    }
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: this.signedUrlTtlSeconds },
    );
  }

  async get(key: string): Promise<{ bytes: Buffer; contentType: string }> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    const bytes = Buffer.from(await result.Body!.transformToByteArray());
    return {
      bytes,
      contentType: result.ContentType ?? "application/octet-stream",
    };
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }
}
