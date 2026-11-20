import type { Hono } from "hono";
import {
  ACCESS_PUBLIC,
  ACCESS_USERS,
  CreateSessionRequest,
  PROTOCOL_VERSION,
  PublicWidgetConfig,
  Session,
} from "@embed-assistant/protocol";
import { verifyUserToken } from "../../auth/userToken.js";
import { getAssistant } from "../../db/store.js";
import { decrypt } from "../../lib/crypto.js";
import { notFound } from "../../lib/errors.js";
import { randomToken } from "../../lib/ids.js";
import { param, route } from "../define.js";
import type { AppEnv, Services } from "../env.js";
import { assertOrigin, type WidgetCache } from "../middleware.js";

const USER_SESSION_MAX_SECONDS = 3600;

export function publicRoutes(app: Hono<AppEnv>, s: Services, widgets: WidgetCache): void {
  route(
    app,
    {
      method: "get",
      path: "/v1/widgets/{widgetId}/config",
      tag: "Widget",
      summary: "Public widget configuration",
      description: "Everything the widget needs to render before the first message. Cacheable for a minute.",
      auth: "none",
      response: { status: 200, schema: PublicWidgetConfig },
    },
    async (c) => {
      const widget = await widgets.get(param(c, "widgetId"));
      if (!widget) throw notFound("widget");
      assertOrigin(c, widget);
      const assistant = await getAssistant(s.sql, widget.tenant_id, widget.assistant_id);
      if (!assistant) throw notFound("widget");
      const body: PublicWidgetConfig = {
        widgetId: widget.id,
        assistant: {
          name: assistant.name,
          greeting: assistant.greeting,
          suggestions: assistant.suggestions,
          placeholder: assistant.placeholder,
          disclaimer: assistant.disclaimer,
        },
        theme: widget.theme,
        defaultLocale: widget.default_locale,
        features: {
          ...widget.features,
          voice: widget.features.voice ?? false,
          attachments: widget.features.attachments === true && s.models.supportsVision(assistant.model_alias),
        },
        memory: assistant.memory && s.models.hasLanguageModel(assistant.model_alias),
        handoff: { enabled: assistant.handoff.enabled, url: assistant.handoff.url, label: assistant.handoff.label },
        protocolVersion: PROTOCOL_VERSION,
      };
      c.header("Cache-Control", "public, max-age=60");
      return c.json(body);
    },
  );

  route(
    app,
    {
      method: "post",
      path: "/v1/sessions",
      tag: "Widget",
      summary: "Start a chat session",
      description:
        "Exchanges an optional host-signed user token (HS256 JWT signed with the widget identity secret) for a " +
        "short-lived session token. Without a user token the visitor is anonymous and can only read `public` knowledge.",
      auth: "none",
      body: CreateSessionRequest,
      response: { status: 201, schema: Session },
    },
    async (c, { body }) => {
      await s.limiter.hit(`sess:ip:${c.get("clientIp")}`, s.cfg.RATE_LIMIT_SESSIONS_PER_HOUR_IP, 3600);
      const widget = await widgets.get(body.widgetId);
      if (!widget) throw notFound("widget");
      assertOrigin(c, widget);

      let subjectId: string;
      let subjectKind: "anonymous" | "user";
      let subjectName: string | null = null;
      let subjectEmail: string | null = null;
      let access: string[];
      let maxExp: number | undefined;
      if (body.userToken) {
        const claims = await verifyUserToken(body.userToken, decrypt(s.secretsKey, widget.identity_secret));
        subjectId = `user:${claims.sub}`;
        subjectKind = "user";
        subjectName = claims.name ?? null;
        subjectEmail = claims.email ?? null;
        access = [...new Set([ACCESS_PUBLIC, ACCESS_USERS, ...(claims.groups ?? [])])];
        // Group changes on the host side take effect within an hour at most.
        maxExp = Math.floor(Date.now() / 1000) + USER_SESSION_MAX_SECONDS;
      } else {
        subjectId = `anon:${body.anonymousId ?? randomToken(18)}`;
        subjectKind = "anonymous";
        access = [ACCESS_PUBLIC];
      }

      const { token, expiresAt } = await s.sessions.sign(
        {
          tenantId: widget.tenant_id,
          widgetId: widget.id,
          assistantId: widget.assistant_id,
          subjectId,
          subjectKind,
          subjectName,
          subjectEmail,
          access,
        },
        maxExp,
      );
      const res: Session = {
        token,
        expiresAt: expiresAt.toISOString(),
        subject: { id: subjectId, kind: subjectKind, name: subjectName },
      };
      c.header("Cache-Control", "no-store");
      return c.json(res, 201);
    },
  );
}
