import { jwtVerify, errors as joseErrors } from "jose";
import { UserTokenClaims } from "@embed-assistant/protocol";
import { unauthorized } from "../lib/errors.js";

/** Host tokens may live at most this long, so a leaked token is only briefly useful. */
export const MAX_USER_TOKEN_LIFETIME_SECONDS = 3600;

/**
 * Verify a host-signed user token (HS256 with the widget's identity secret).
 * Any language with a JWT library can produce one; see docs/identity.md.
 */
export async function verifyUserToken(token: string, secret: string): Promise<UserTokenClaims> {
  let payload: unknown;
  try {
    ({ payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      algorithms: ["HS256"],
      clockTolerance: 60,
      requiredClaims: ["sub", "exp"],
    }));
  } catch (err) {
    if (err instanceof joseErrors.JOSEError) throw unauthorized(`invalid user token: ${err.code}`);
    throw err;
  }
  const parsed = UserTokenClaims.safeParse(payload);
  if (!parsed.success) throw unauthorized("invalid user token claims");
  const now = Math.floor(Date.now() / 1000);
  if (parsed.data.exp - now > MAX_USER_TOKEN_LIFETIME_SECONDS + 60) {
    throw unauthorized(`user token lifetime exceeds ${MAX_USER_TOKEN_LIFETIME_SECONDS}s`);
  }
  return parsed.data;
}
