import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// Cloudflare R2 speaks the S3 API. Videos never pass through this server: the browser uploads to and
// downloads from R2 directly, with short-lived signed links made here.
// R2_ENDPOINT is only for local testing against another S3-compatible store.

let client: S3Client | undefined;

function r2() {
  client ??= new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT ?? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    forcePathStyle: true, // links look like https://<account>.r2.cloudflarestorage.com/<bucket>/<key>
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
    // Newer AWS SDKs add checksum headers by default, which signed browser uploads can't send.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  return client;
}

const bucket = () => process.env.R2_BUCKET!;

/** Link the browser PUTs the video to. Size and type are part of the signature, so they can't be changed. */
export function uploadUrl(key: string, bytes: number, contentType: string) {
  return getSignedUrl(
    r2(),
    new PutObjectCommand({ Bucket: bucket(), Key: key, ContentLength: bytes, ContentType: contentType }),
    { expiresIn: 60 * 60 * 6, signableHeaders: new Set(["content-length", "content-type"]) },
  );
}

/** Link to play (inline) or download (with a file name) one object. Valid for `seconds` (default one hour). */
export function downloadUrl(key: string, filename?: string, seconds = 60 * 60) {
  return getSignedUrl(
    r2(),
    new GetObjectCommand({
      Bucket: bucket(),
      Key: key,
      ResponseContentDisposition: filename ? `attachment; filename="${filename.replace(/[^\w.\- ]/g, "_")}"` : undefined,
    }),
    { expiresIn: seconds },
  );
}

/** Size of an object in bytes, or null when it isn't there. */
export async function objectSize(key: string): Promise<number | null> {
  try {
    const head = await r2().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
    return head.ContentLength ?? null;
  } catch (e) {
    if ((e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}
