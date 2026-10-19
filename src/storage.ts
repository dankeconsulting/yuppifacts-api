import { HeadObjectCommand, PutObjectCommand,S3Client } from "@aws-sdk/client-s3"; import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
const bucket=process.env.AWS_S3_BUCKET; const client=new S3Client({region:process.env.AWS_REGION});
export async function createUploadUrl(input:{taxpayerId:string;filename:string;contentType:"application/pdf"|"image/jpeg"|"image/png"}){if(!bucket)throw new Error("AWS_S3_BUCKET is required");const safeName=input.filename.replace(/[^a-zA-Z0-9._-]/g,"_");const key=`taxpayers/${input.taxpayerId}/documents/${crypto.randomUUID()}-${safeName}`;const command=new PutObjectCommand({Bucket:bucket,Key:key,ContentType:input.contentType,ServerSideEncryption:"aws:kms",SSEKMSKeyId:process.env.AWS_KMS_KEY_ID||undefined,Metadata:{taxpayerId:input.taxpayerId}});return{key,uploadUrl:await getSignedUrl(client,command,{expiresIn:300}),expiresIn:300}}

export async function createPromotionVoucherUploadUrl(input:{voucherId:string;filename:string;contentType:"application/pdf"|"image/jpeg"|"image/png"}) {
  if (!bucket) throw new Error("AWS_S3_BUCKET is required");
  const safeName=input.filename.replace(/[^a-zA-Z0-9._-]/g,"_");
  const key=`promotion-vouchers/${input.voucherId}/${safeName}`;
  const command=new PutObjectCommand({Bucket:bucket,Key:key,ContentType:input.contentType,ServerSideEncryption:"aws:kms",SSEKMSKeyId:process.env.AWS_KMS_KEY_ID||undefined,Metadata:{voucherId:input.voucherId}});
  return { key, uploadUrl:await getSignedUrl(client,command,{expiresIn:300}),expiresIn:300 };
}

export async function verifyPromotionVoucherUpload(input:{key:string;contentType:"application/pdf"|"image/jpeg"|"image/png";byteSize:number}) {
  if (!bucket) throw new Error("AWS_S3_BUCKET is required");
  try {
    const object=await client.send(new HeadObjectCommand({Bucket:bucket,Key:input.key}));
    return object.ContentType === input.contentType && object.ContentLength === input.byteSize;
  } catch { return false; }
}
