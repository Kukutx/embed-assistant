import { SignJWT, jwtVerify, errors as joseErrors } from "jose";
import { unauthorized } from "../lib/errors.js";

export interface SessionClaims {
  tenantId: string;
  widgetId: string;
  assistantId: string;
  subjectId: string;
  subjectKind: "anonymous" | "user";
  subjectName: string | null;
  /** E-mail from the host's user token (forwarded to actions that require a user). */
  subjectEmail?: string | null;
  /** Knowledge access tags this session may read. */
  access: string[];
}

const ISSUER = "embed-assistant";
const AUDIENCE = "embed-assistant:chat";

/** Chat session tokens: short-lived HS256 JWTs signed with a key derived from SECRET_KEY. */
export class SessionSigner {
  constructor(
    private readonly key: Uint8Array,
    private readonly ttlSeconds: number,
  ) {}

  async sign(claims: SessionClaims, maxExp?: number): Promise<{ token: string; expiresAt: Date }> {
    const now = Math.floor(Date.now() / 1000);
    const exp = Math.min(now + this.ttlSeconds, maxExp ?? Number.MAX_SAFE_INTEGER);
    const token = await new SignJWT({
      tid: claims.tenantId,
      wid: claims.widgetId,
      aid: claims.assistantId,
      knd: claims.subjectKind,
      nam: claims.subjectName,
      ...(claims.subjectEmail ? { eml: claims.subjectEmail } : {}),
      acc: claims.access,
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(claims.subjectId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(now)
      .setExpirationTime(exp)
      .sign(this.key);
    return { token, expiresAt: new Date(exp * 1000) };
  }

  async verify(token: string): Promise<SessionClaims> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ["HS256"],
      });
      const p = payload as Record<string, unknown>;
      if (
        typeof p.sub !== "string" ||
        typeof p.tid !== "string" ||
        typeof p.wid !== "string" ||
        typeof p.aid !== "string" ||
        (p.knd !== "anonymous" && p.knd !== "user") ||
        !Array.isArray(p.acc)
      ) {
        throw unauthorized("malformed session token");
      }
      return {
        tenantId: p.tid,
        widgetId: p.wid,
        assistantId: p.aid,
        subjectId: p.sub,
        subjectKind: p.knd,
        subjectName: typeof p.nam === "string" ? p.nam : null,
        subjectEmail: typeof p.eml === "string" ? p.eml : null,
        access: p.acc.filter((x): x is string => typeof x === "string"),
      };
    } catch (err) {
      if (err instanceof joseErrors.JOSEError) throw unauthorized("invalid or expired session token");
      throw err;
    }
  }
}
