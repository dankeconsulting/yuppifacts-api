import { createHash, randomBytes, randomInt, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

function deriveSecret(value: string, salt: string, length: number) {
  return new Promise<Buffer>((resolve, reject) => {
    scryptCallback(value, salt, length, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function randomOtp() {
  return String(randomInt(1000, 10_000));
}

export async function hashSecret(value: string) {
  const salt = randomBytes(16).toString("base64url");
  const derived = await deriveSecret(value, salt, 64);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt}$${derived.toString("base64url")}`;
}

export async function verifySecret(value: string, stored: string) {
  const [algorithm, n, r, p, salt, encoded] = stored.split("$");
  if (algorithm !== "scrypt" || !n || !r || !p || !salt || !encoded) return false;
  const expected = Buffer.from(encoded, "base64url");
  const candidate = Buffer.from(await deriveSecret(value, salt, expected.length));
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export function hashOpaqueToken(token: string) {
  return createHash("sha256").update(token).digest("base64url");
}

export function safeEqualSecret(received: string, expected: string) {
  const receivedBytes = Buffer.from(received);
  const expectedBytes = Buffer.from(expected);
  return receivedBytes.length === expectedBytes.length && timingSafeEqual(receivedBytes, expectedBytes);
}

export function hashIp(ip: string | undefined) {
  return ip ? createHash("sha256").update(ip).digest("base64url") : null;
}
