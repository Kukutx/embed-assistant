import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32

/** Time-sortable 26-char ULID (48-bit ms timestamp + 80 random bits). */
export function ulid(now: number = Date.now()): string {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(16);
  let rand = "";
  for (let i = 0; i < 16; i++) rand += ALPHABET[bytes[i]! % 32];
  return time + rand;
}

export type IdPrefix =
  | "ten" | "key" | "ast" | "wgt" | "conv" | "msg" | "run" | "src" | "doc" | "chk" | "job" | "anon" | "act" | "whk" | "evt" | "call" | "mcp" | "aud" | "usr" | "evs" | "evc" | "evr";

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${ulid()}`;
}

/** URL-safe random token. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
