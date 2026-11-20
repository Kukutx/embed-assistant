/** Playbooks: plain-language procedures an assistant opens when a request matches. */
import type { Context, Hono } from "hono";
import { z } from "zod";
import { Playbook, PlaybookInput, PlaybookPatch } from "@embed-assistant/protocol";
import { conflict, notFound } from "../../lib/errors.js";
import { createPlaybook, deletePlaybook, getPlaybook, listPlaybooks, toPlaybook, updatePlaybook } from "../../playbooks/playbooks.js";
import { param, route } from "../define.js";
import type { AppEnv, Services } from "../env.js";

const isUniqueViolation = (err: unknown) => (err as { code?: string })?.code === "23505";

export function playbookRoutes(app: Hono<AppEnv>, s: Services): void {
  const { sql } = s;
  const T = "Admin: playbooks";
  const tid = (c: Context<AppEnv>) => c.get("tenantId");
  const taken = (name?: string) => conflict(`a playbook named "${name ?? ""}" already exists`);

  route(app, { method: "get", path: "/v1/admin/playbooks", tag: T, summary: "List playbooks", auth: "admin", response: { status: 200, schema: z.object({ items: z.array(Playbook) }) } },
    async (c) => c.json({ items: (await listPlaybooks(sql, tid(c))).map(toPlaybook) }));

  route(app, {
      method: "post", path: "/v1/admin/playbooks", tag: T, summary: "Create a playbook",
      description:
        "Steps to follow for one kind of request (a refund, a password reset, troubleshooting a device), in plain language. " +
        "Attach it to assistants with `playbookIds`; the model sees its name and description and reads the steps when a request matches.",
      auth: "admin", body: PlaybookInput, response: { status: 201, schema: Playbook },
    },
    async (c, { body }) => {
      try {
        return c.json(toPlaybook(await createPlaybook(sql, tid(c), body)), 201);
      } catch (err) {
        if (isUniqueViolation(err)) throw taken(body.name);
        throw err;
      }
    });

  route(app, { method: "get", path: "/v1/admin/playbooks/{id}", tag: T, summary: "Get a playbook", auth: "admin", response: { status: 200, schema: Playbook } },
    async (c) => {
      const p = await getPlaybook(sql, tid(c), param(c, "id"));
      if (!p) throw notFound("playbook");
      return c.json(toPlaybook(p));
    });

  route(app, { method: "patch", path: "/v1/admin/playbooks/{id}", tag: T, summary: "Update a playbook", auth: "admin", body: PlaybookPatch, response: { status: 200, schema: Playbook } },
    async (c, { body }) => {
      try {
        const p = await updatePlaybook(sql, tid(c), param(c, "id"), Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)));
        if (!p) throw notFound("playbook");
        return c.json(toPlaybook(p));
      } catch (err) {
        if (isUniqueViolation(err)) throw taken(body.name);
        throw err;
      }
    });

  route(app, { method: "delete", path: "/v1/admin/playbooks/{id}", tag: T, summary: "Delete a playbook (and detach it from assistants)", auth: "admin", response: { status: 204 } },
    async (c) => {
      if (!(await deletePlaybook(sql, tid(c), param(c, "id")))) throw notFound("playbook");
      return c.body(null, 204);
    });
}
