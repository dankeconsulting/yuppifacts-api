import { DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3"; import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
const bucket=process.env.AWS_S3_BUCKET; const client=new S3Client({region:process.env.AWS_REGION});
export class PromotionVoucherDeletionError extends Error {
  constructor(public readonly codes:string[]) { super("No fue posible eliminar todos los comprobantes almacenados."); }
}
export async function createUploadUrl(input:{taxpayerId:string;filename:string;contentType:"application/pdf"|"image/jpeg"|"image/png"}){if(!bucket)throw new Error("AWS_S3_BUCKET is required");const safeName=input.filename.replace(/[^a-zA-Z0-9._-]/g,"_");const key=`taxpayers/${input.taxpayerId}/documents/${crypto.randomUUID()}-${safeName}`;const command=new PutObjectCommand({Bucket:bucket,Key:key,ContentType:input.contentType,ServerSideEncryption:"aws:kms",SSEKMSKeyId:process.env.AWS_KMS_KEY_ID||undefined,Metadata:{taxpayerId:input.taxpayerId}});return{key,uploadUrl:await getSignedUrl(client,command,{expiresIn:300}),expiresIn:300}}

export async function createPromotionVoucherUploadUrl(input:{voucherId:string;filename:string;contentType:"application/pdf"|"image/jpeg"|"image/png"}) {
  if (!bucket) throw new Error("AWS_S3_BUCKET is required");
  const safeName=input.filename.replace(/[^a-zA-Z0-9._-]/g,"_");
  const prefix=(process.env.AWS_S3_PROMOTION_PREFIX ?? "dankeconsulting/yuppifacts/promotions/vouchers").replace(/^\/+|\/+$/g, "");
  const key=`${prefix}/${input.voucherId}/${safeName}`;
  // The private vouchers bucket uses S3-managed encryption.  Keeping the
  // upload request on AES256 avoids requiring a separate KMS key permission
  // just to issue and use the short-lived upload URL.
  const command=new PutObjectCommand({Bucket:bucket,Key:key,ContentType:input.contentType,ServerSideEncryption:"AES256",Metadata:{voucherId:input.voucherId}});
  return { key, uploadUrl:await getSignedUrl(client,command,{expiresIn:300}),expiresIn:300 };
}

export async function verifyPromotionVoucherUpload(input:{key:string;contentType:"application/pdf"|"image/jpeg"|"image/png";byteSize:number}) {
  if (!bucket) throw new Error("AWS_S3_BUCKET is required");
  try {
    const object=await client.send(new HeadObjectCommand({Bucket:bucket,Key:input.key}));
    return object.ContentType === input.contentType && object.ContentLength === input.byteSize;
  } catch { return false; }
}

export async function createPromotionVoucherViewUrl(key:string) {
  if (!bucket) throw new Error("AWS_S3_BUCKET is required");
  return getSignedUrl(client,new GetObjectCommand({Bucket:bucket,Key:key}),{expiresIn:300});
}

export async function deletePromotionVoucherObjects(keys: string[]) {
  if (!bucket || keys.length === 0) return;
  for (let offset = 0; offset < keys.length; offset += 1000) {
    const response = await client.send(new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: { Objects: keys.slice(offset, offset + 1000).map(Key => ({ Key })), Quiet: true },
    }));
    if (response.Errors?.length) {
      const codes=response.Errors.map(error=>error.Code ?? "UnknownError");
      console.error("Promotion voucher deletion rejected by object storage", { codes });
      throw new PromotionVoucherDeletionError(codes);
    }
  }
}
