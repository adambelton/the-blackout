import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";

const bucket = process.argv[2];
if (!bucket) {
  console.error("Usage: tsx scripts/r2-smoke.ts <bucket>");
  process.exit(1);
}

const client = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});

const Key = `smoke/test-${Date.now()}.txt`;
const body = "smoke";

await client.send(new PutObjectCommand({ Bucket: bucket, Key, Body: body }));
console.log(`PUT ok → ${bucket}/${Key}`);

const got = await client.send(new GetObjectCommand({ Bucket: bucket, Key }));
const text = await got.Body!.transformToString();
console.log(`GET ok → ${text === body ? "round-trip identical" : "MISMATCH"}`);

await client.send(new DeleteObjectCommand({ Bucket: bucket, Key }));
console.log(`DELETE ok`);
