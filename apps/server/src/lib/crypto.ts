import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

/** Derive independent 32-byte keys from the root SECRET_KEY. */
export function deriveKey(secret: string, purpose: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, "embed-assistant", purpose, 32));
}

/** AES-256-GCM. Output: v1.<iv>.<tag>.<ciphertext>, base64url parts. */
export function encrypt(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

/**
 * A key that also carries older keys still accepted for decryption, for
 * SECRET_KEY rotation: new values are always encrypted with the current key,
 * existing values decrypt with whichever key wrote them until
 * `rotate-secrets` re-encrypts them. It is a plain Buffer everywhere else.
 */
export function keyring(current: Buffer, previous: readonly Buffer[]): Buffer {
  return Object.defineProperty(Buffer.from(current), "previous", { value: previous, enumerable: false });
}
const previousKeys = (key: Buffer): readonly Buffer[] => (key as Buffer & { previous?: readonly Buffer[] }).previous ?? [];

function decryptWith(key: Buffer, iv: string, tag: string, ct: string): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
}

export function decrypt(key: Buffer, payload: string): string {
  const [v, iv, tag, ct] = payload.split(".");
  if (v !== "v1" || !iv || !tag || ct === undefined) throw new Error("unsupported ciphertext");
  try {
    return decryptWith(key, iv, tag, ct);
  } catch (err) {
    // GCM authentication fails for a value written with another key: try the previous ones.
    for (const old of previousKeys(key)) {
      try {
        return decryptWith(old, iv, tag, ct);
      } catch {
        /* next */
      }
    }
    throw err;
  }
}

/** True when the value was written with the current key (no re-encryption needed). */
export function isCurrent(key: Buffer, payload: string): boolean {
  const [v, iv, tag, ct] = payload.split(".");
  if (v !== "v1" || !iv || !tag || ct === undefined) return false;
  try {
    decryptWith(key, iv, tag, ct);
    return true;
  } catch {
    return false;
  }
}

export function sha256(input: string): Buffer {
  return createHash("sha256").update(input).digest();
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
