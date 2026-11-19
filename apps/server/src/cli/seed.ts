/**
 * First-run setup: creates a tenant, an admin key, a demo knowledge source,
 * an assistant and a widget, then prints everything needed to embed it.
 *
 *   pnpm seed                 # only when the database has no tenant yet
 *   pnpm seed --new-admin-key # issue another admin key for the first tenant
 */
import { generateAdminKey } from "../auth/adminKey.js";
import { loadConfig } from "../config.js";
import { createSql } from "../db/pool.js";
import { migrate } from "../db/migrate.js";
import { createAssistant, createSource, createTenant, createWidget, insertAdminKey, setSourceStatus } from "../db/store.js";
import { upsertDocument } from "../knowledge/ingest.js";
import { deriveKey, encrypt } from "../lib/crypto.js";
import { createLogger } from "../lib/log.js";
import { randomToken } from "../lib/ids.js";
import { loadModelsFile, ModelRegistry } from "../models/registry.js";
import { DEMO_DOCS } from "./demoDocs.js";

const cfg = loadConfig();
const sql = createSql(cfg.DATABASE_URL, 2);
const log = createLogger("warn");

try {
  await migrate(sql);
  const existing = await sql<{ id: string; name: string }[]>`SELECT id, name FROM tenants ORDER BY created_at LIMIT 1`;

  if (process.argv.includes("--new-admin-key")) {
    const tenant = existing[0];
    if (!tenant) throw new Error("no tenant yet; run `pnpm seed` without flags first");
    const k = generateAdminKey();
    await insertAdminKey(sql, tenant.id, "cli", k.hash, k.prefix);
    console.log(`New admin key for tenant ${tenant.name} (${tenant.id}):\n\n  ${k.key}\n`);
  } else if (existing[0]) {
    console.log("Already seeded. Use `pnpm seed --new-admin-key` to issue another admin key.");
  } else {
    const tenantId = await createTenant(sql, "Default");
    const k = generateAdminKey();
    await insertAdminKey(sql, tenantId, "seed", k.hash, k.prefix);

    const models = new ModelRegistry(loadModelsFile(cfg));
    const deps = { sql, log, embeddings: models.embeddings, allowPrivate: cfg.INGEST_ALLOW_PRIVATE_NETWORKS };
    const source = await createSource(sql, tenantId, { name: "Getting started (demo)", type: "manual", url: null, access: ["public"], maxPages: 1 });
    for (const d of DEMO_DOCS) await upsertDocument(deps, source, { externalId: d.slug, title: d.title, url: null, content: d.content });
    await setSourceStatus(sql, tenantId, source.id, "succeeded");

    const assistant = await createAssistant(sql, tenantId, {
      name: "Assistant",
      instructions: "",
      modelAlias: "standard",
      greeting: "Hi! Ask me anything about this product.",
      suggestions: ["How do I embed the assistant?", "How do signed-in users work?", "Which AI models are supported?"],
      placeholder: null,
      disclaimer: "AI answers can be wrong. Check important information.",
      sourceIds: [source.id],
      groundedOnly: true,
    });
    const origin = new URL(cfg.PUBLIC_BASE_URL).origin;
    const secret = `ea_whs_${randomToken(32)}`;
    const widget = await createWidget(
      sql,
      tenantId,
      {
        assistantId: assistant.id,
        name: "Demo widget",
        allowedOrigins: [...new Set([origin, "http://localhost:3000", "http://localhost:5173", "http://localhost:8080"])],
        theme: { accentColor: "#2563eb", mode: "auto", position: "bottom-right", radius: 16 },
        defaultLocale: null,
        features: { feedback: true, sources: true, history: true },
        dailyTokenBudget: null,
      },
      encrypt(deriveKey(cfg.SECRET_KEY, "widget-secret-encryption"), secret),
    );

    console.log(`
embed-assistant is ready.

  Admin console   ${cfg.PUBLIC_BASE_URL}/admin/
  Demo page       ${cfg.PUBLIC_BASE_URL}/demo?widget=${widget.id}
  API reference   ${cfg.PUBLIC_BASE_URL}/openapi.json

  Admin key (shown once, keep it secret):
    ${k.key}

  Widget identity secret (shown once; your BACKEND uses it to sign user tokens):
    ${secret}

  Embed on any page:
    <script src="${cfg.PUBLIC_BASE_URL}/widget/loader.js" data-widget-id="${widget.id}" async></script>
`);
  }
} finally {
  await sql.end({ timeout: 5 });
}
