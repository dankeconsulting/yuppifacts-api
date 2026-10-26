import { DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3"; import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
export type SupportedContentType = "application/pdf" | "image/jpeg" | "image/png" | "image/webp" | "application/xml" | "text/xml";
type StorageProvider = "aws-s3" | "cloudflare-r2";

const legacyBucket = process.env.AWS_S3_BUCKET;
const legacyClient = new S3Client({ region: process.env.AWS_REGION });

function firstEnvironmentValue(...names: string[]) {
  return names.map((name) => process.env[name]?.trim()).find(Boolean);
}

const r2AccountId = firstEnvironmentValue("R2_ACCOUNT_ID", "CLOUDFLARE_R2_ACCOUNT_ID", "CLOUDFLARE_ACCOUNT_ID");
const r2AccessKeyId = firstEnvironmentValue("R2_ACCESS_KEY_ID", "CLOUDFLARE_R2_ACCESS_KEY_ID", "CLOUDFLARE_R2_ACCESS_KEY");
const r2SecretAccessKey = firstEnvironmentValue("R2_SECRET_ACCESS_KEY", "CLOUDFLARE_R2_SECRET_ACCESS_KEY", "CLOUDFLARE_R2_SECRET_KEY");
const r2Bucket = firstEnvironmentValue("R2_BUCKET", "CLOUDFLARE_R2_BUCKET", "R2_BUCKET_NAME");
const r2Prefix = (firstEnvironmentValue("R2_PREFIX", "CLOUDFLARE_R2_PREFIX") ?? "yuppifacts").replace(/^\/+|\/+$/g, "");
const r2Values = [r2AccountId, r2AccessKeyId, r2SecretAccessKey, r2Bucket];
const isR2Configured = r2Values.every(Boolean);
const hasPartialR2Configuration = r2Values.some(Boolean) && !isR2Configured;

// Diagnostic only: report whether each required configuration value was supplied,
// never its value.  This makes a deployment misconfiguration observable without
// exposing a credential in logs.
export const r2ConfigurationStatus = {
  accountId: Boolean(r2AccountId),
  accessKeyId: Boolean(r2AccessKeyId),
  secretAccessKey: Boolean(r2SecretAccessKey),
  bucket: Boolean(r2Bucket),
  configured: isR2Configured,
};

const r2Client = isR2Configured
  ? new S3Client({
      region: "auto",
      endpoint: `https://${r2AccountId}.r2.cloudflarestorage.com`,
      forcePathStyle: true,
      credentials: { accessKeyId: r2AccessKeyId!, secretAccessKey: r2SecretAccessKey! },
    })
  : null;

function requireR2Configuration() {
  if (hasPartialR2Configuration) throw new Error("R2 must define R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET together");
  if (!r2Client || !r2Bucket) throw new Error("Cloudflare R2 is not configured");
  return { client: r2Client, bucket: r2Bucket };
}

function storageForKey(key: string): { provider: StorageProvider; client: S3Client; bucket: string } {
  if (key.startsWith("r2/")) return { provider: "cloudflare-r2", ...requireR2Configuration() };
  if (!legacyBucket) throw new Error("AWS_S3_BUCKET is required for legacy stored files");
  return { provider: "aws-s3", client: legacyClient, bucket: legacyBucket };
}

function storageForNewFile(): { provider: StorageProvider; client: S3Client; bucket: string } {
  if (hasPartialR2Configuration) requireR2Configuration();
  if (isR2Configured) return { provider: "cloudflare-r2", ...requireR2Configuration() };
  if (!legacyBucket) throw new Error("AWS_S3_BUCKET is required until Cloudflare R2 is configured");
  return { provider: "aws-s3", client: legacyClient, bucket: legacyBucket };
}

function keyForNewFile(prefix: string, safeName: string) {
  return isR2Configured ? `r2/${r2Prefix}/${prefix}/${crypto.randomUUID()}-${safeName}` : `${prefix}/${crypto.randomUUID()}-${safeName}`;
}

function uploadCommand(provider: StorageProvider, bucket: string, key: string, contentType: SupportedContentType, metadata: Record<string, string>) {
  if (provider === "cloudflare-r2") return new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType, Metadata: metadata });
  return new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType, ServerSideEncryption: "AES256", Metadata: metadata });
}
export class PromotionVoucherDeletionError extends Error {
  constructor(public readonly codes:string[]) { super("No fue posible eliminar todos los comprobantes almacenados."); }
}
export async function verifyObjectStorageConnection() {
  const storage = storageForNewFile();
  await storage.client.send(new ListObjectsV2Command({ Bucket: storage.bucket, MaxKeys: 1 }));
  return { provider: storage.provider, bucket: storage.bucket };
}

export async function createUploadUrl(input: { taxpayerId: string; filename: string; contentType: SupportedContentType }) {
  const storage = storageForNewFile();
  const safeName = input.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const key = keyForNewFile(`taxpayers/${input.taxpayerId}/documents`, safeName);
  return {
    key,
    uploadUrl: await getSignedUrl(storage.client, uploadCommand(storage.provider, storage.bucket, key, input.contentType, { taxpayerId: input.taxpayerId }), { expiresIn: 300 }),
    expiresIn: 300,
  };
}

export async function createUserAvatarUploadUrl(input: { userId: string; filename: string; contentType: Extract<SupportedContentType, "image/jpeg" | "image/png" | "image/webp"> }) {
  const storage = storageForNewFile();
  const safeName = input.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const key = keyForNewFile(`users/${input.userId}/avatar`, safeName);
  return {
    key,
    uploadUrl: await getSignedUrl(storage.client, uploadCommand(storage.provider, storage.bucket, key, input.contentType, { userId: input.userId, assetType: "avatar" }), { expiresIn: 300 }),
    expiresIn: 300,
  };
}

export async function verifyUserAvatarUpload(input: { key: string; contentType: Extract<SupportedContentType, "image/jpeg" | "image/png" | "image/webp">; byteSize: number }) {
  try {
    const storage = storageForKey(input.key);
    const object = await storage.client.send(new HeadObjectCommand({ Bucket: storage.bucket, Key: input.key }));
    return object.ContentType === input.contentType && object.ContentLength === input.byteSize;
  } catch { return false; }
}

export async function createPrivateViewUrl(key: string) {
  const storage = storageForKey(key);
  return getSignedUrl(storage.client, new GetObjectCommand({ Bucket: storage.bucket, Key: key }), { expiresIn: 300 });
}

export async function deletePrivateObject(key: string) {
  const storage = storageForKey(key);
  await storage.client.send(new DeleteObjectsCommand({ Bucket: storage.bucket, Delete: { Objects: [{ Key: key }], Quiet: true } }));
}

export async function createPromotionVoucherUploadUrl(input: { voucherId: string; filename: string; contentType: SupportedContentType }) {
  const storage = storageForNewFile();
  const safeName=input.filename.replace(/[^a-zA-Z0-9._-]/g,"_");
  const legacyPrefix=(process.env.AWS_S3_PROMOTION_PREFIX ?? "dankeconsulting/yuppifacts/promotions/vouchers").replace(/^\/+|\/+$/g, "");
  const prefix=storage.provider === "cloudflare-r2" ? "promotions/vouchers" : legacyPrefix;
  const baseKey=`${prefix}/${input.voucherId}/${safeName}`;
  const key=isR2Configured ? `r2/${r2Prefix}/${baseKey}` : baseKey;
  return { key, uploadUrl:await getSignedUrl(storage.client, uploadCommand(storage.provider, storage.bucket, key, input.contentType, { voucherId: input.voucherId }),{expiresIn:300}),expiresIn:300 };
}

export async function verifyPromotionVoucherUpload(input: { key: string; contentType: SupportedContentType; byteSize: number }) {
  try {
    const storage=storageForKey(input.key);
    const object=await storage.client.send(new HeadObjectCommand({Bucket:storage.bucket,Key:input.key}));
    return object.ContentType === input.contentType && object.ContentLength === input.byteSize;
  } catch { return false; }
}

export async function createPromotionVoucherViewUrl(key:string) {
  const storage=storageForKey(key);
  return getSignedUrl(storage.client,new GetObjectCommand({Bucket:storage.bucket,Key:key}),{expiresIn:300});
}

export async function deletePromotionVoucherObjects(keys: string[]) {
  const groups = new Map<StorageProvider, string[]>();
  for (const key of keys) {
    const provider: StorageProvider = key.startsWith("r2/") ? "cloudflare-r2" : "aws-s3";
    groups.set(provider, [...(groups.get(provider) ?? []), key]);
  }
  for (const [provider, providerKeys] of groups) {
    const storage = provider === "cloudflare-r2" ? requireR2Configuration() : storageForKey(providerKeys[0]);
    for (let offset = 0; offset < providerKeys.length; offset += 1000) {
      const response = await storage.client.send(new DeleteObjectsCommand({
        Bucket: storage.bucket,
        Delete: { Objects: providerKeys.slice(offset, offset + 1000).map((key) => ({ Key: key })), Quiet: true },
      }));
      if (response.Errors?.length) {
        const codes=response.Errors.map(error=>error.Code ?? "UnknownError");
        console.error("Promotion voucher deletion rejected by object storage", { provider, codes });
        throw new PromotionVoucherDeletionError(codes);
      }
    }
  }
}
