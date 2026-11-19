import type { Context, Hono } from "hono";
import { z } from "zod";
import { PROTOCOL_VERSION } from "@embed-assistant/protocol";
import { can, routePermission } from "../auth/permissions.js";
import { badRequest, forbidden, unauthorized } from "../lib/errors.js";
import type { AppEnv } from "./env.js";

/**
 * A thin route layer: each route is declared once with its zod schemas, which
 * are used both to validate requests and to generate the OpenAPI document.
 * No codegen and no framework lock-in beyond a plain Hono handler.
 */
export type Auth = "none" | "session" | "admin" | "platform";

export interface RouteSpec<B extends z.ZodType | undefined, Q extends z.ZodType | undefined> {
  method: "get" | "post" | "put" | "patch" | "delete";
  /** OpenAPI-style path, e.g. `/v1/conversations/{id}`. */
  path: string;
  tag: string;
  summary: string;
  description?: string;
  auth: Auth;
  body?: B;
  query?: Q;
  response: { status: number; schema?: z.ZodType; description?: string; contentType?: string };
}

type Infer<T> = T extends z.ZodType ? z.infer<T> : undefined;

export interface Input<B, Q> {
  body: Infer<B>;
  query: Infer<Q>;
}

const registry: RouteSpec<z.ZodType | undefined, z.ZodType | undefined>[] = [];

export function route<B extends z.ZodType | undefined = undefined, Q extends z.ZodType | undefined = undefined>(
  app: Hono<AppEnv>,
  spec: RouteSpec<B, Q>,
  handler: (c: Context<AppEnv>, input: Input<B, Q>) => Promise<Response> | Response,
): void {
  if (!registry.some((r) => r.method === spec.method && r.path === spec.path)) registry.push(spec);
  const honoPath = spec.path.replace(/\{(\w+)\}/g, ":$1");
  const permission = spec.auth === "admin" ? routePermission(spec.method, spec.path) : null;
  app.on(spec.method.toUpperCase(), honoPath, async (c) => {
    if (spec.auth === "admin") {
      const actor = c.get("actor");
      if (!actor || !can(actor.role, permission)) throw forbidden(`your role (${actor?.role ?? "none"}) does not allow this (needs ${permission})`);
    }
    // Fail closed if a session route was mounted without the session middleware.
    if (spec.auth === "session" && !c.get("session")) throw unauthorized();
    let body: unknown = undefined;
    let query: unknown = undefined;
    if (spec.body) {
      let raw: unknown;
      try {
        raw = await c.req.json();
      } catch {
        throw badRequest("request body must be valid JSON");
      }
      body = parseOr400(spec.body, raw, "body");
    }
    if (spec.query) query = parseOr400(spec.query, c.req.query(), "query");
    return handler(c, { body, query } as Input<B, Q>);
  });
}

function parseOr400(schema: z.ZodType, value: unknown, where: string): unknown {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw badRequest(`invalid ${where}`, r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  return r.data;
}

/** Path parameter helper that never returns undefined. */
export const param = (c: Context<AppEnv>, name: string): string => c.req.param(name) ?? "";

export function openApiDocument(baseUrl: string, version: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  const toSchema = (s: z.ZodType, io: "input" | "output") =>
    z.toJSONSchema(s, { io, unrepresentable: "any", target: "openapi-3.0" }) as Record<string, unknown>;

  for (const r of registry) {
    const params = [...r.path.matchAll(/\{(\w+)\}/g)].map((m) => ({
      name: m[1],
      in: "path",
      required: true,
      schema: { type: "string" },
    }));
    if (r.query) {
      const qs = toSchema(r.query, "input") as { properties?: Record<string, unknown>; required?: string[] };
      for (const [name, schema] of Object.entries(qs.properties ?? {})) {
        params.push({ name, in: "query", required: qs.required?.includes(name) ?? false, schema } as never);
      }
    }
    const op: Record<string, unknown> = {
      tags: [r.tag],
      summary: r.summary,
      ...(r.description || r.auth === "admin"
        ? { description: [r.description, r.auth === "admin" ? requiredPermissionText(r.method, r.path) : null].filter(Boolean).join("\n\n") }
        : {}),
      ...(r.auth === "admin" ? { "x-permission": routePermission(r.method, r.path) } : {}),
      operationId: `${r.method}${r.path.replace(/\/v1/, "").replace(/[{}]/g, "").replace(/[/-](\w)/g, (_, ch: string) => ch.toUpperCase())}`,
      parameters: params,
      security: r.auth === "none" ? [] : [{ [{ admin: "adminKey", platform: "platformToken", session: "sessionToken" }[r.auth]]: [] }],
      responses: {
        [String(r.response.status)]: {
          description: r.response.description ?? "OK",
          ...(r.response.schema
            ? { content: { [r.response.contentType ?? "application/json"]: { schema: toSchema(r.response.schema, "output") } } }
            : {}),
        },
        default: {
          description: "Error",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
        },
      },
    };
    if (r.body) op.requestBody = { required: true, content: { "application/json": { schema: toSchema(r.body, "input") } } };
    (paths[r.path] ??= {})[r.method] = op;
  }

  return {
    openapi: "3.0.3",
    info: {
      title: "embed-assistant API",
      version,
      description:
        `Protocol version ${PROTOCOL_VERSION}. Public chat endpoints authenticate with a short-lived session token ` +
        "from POST /v1/sessions. Admin endpoints use a tenant admin key. Run events stream as Server-Sent Events.",
      license: { name: "Apache-2.0" },
    },
    servers: [{ url: baseUrl }],
    paths,
    components: {
      securitySchemes: {
        sessionToken: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        adminKey: { type: "http", scheme: "bearer", description: "Tenant admin key (ea_admin_..., every permission) or console session token (ea_cs_..., the user's role decides)" },
        platformToken: { type: "http", scheme: "bearer", description: "PLATFORM_ADMIN_TOKEN of the installation (operators only; the platform API is off when it is unset)" },
      },
      schemas: {
        Error: {
          type: "object",
          required: ["error"],
          properties: {
            error: {
              type: "object",
              required: ["code", "message"],
              properties: {
                code: { type: "string" },
                message: { type: "string" },
                requestId: { type: "string" },
                details: {},
              },
            },
          },
        },
      },
    },
  };
}

function requiredPermissionText(method: string, path: string): string {
  const p = routePermission(method, path);
  return p ? `Requires the \`${p}\` permission.` : "Any signed-in caller.";
}
