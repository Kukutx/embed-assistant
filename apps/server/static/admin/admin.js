// embed-assistant admin console. Plain ES module, no build step; talks only to /v1/admin/*.
const KEY = "embed-assistant-admin-key";
const app = document.getElementById("app");

// ------------------------------------------------------------------ helpers
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "value") el.value = v;
    else if (k === "checked") el.checked = !!v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}
const fmtDate = (s) => (s ? new Date(s).toLocaleString() : "—");
const getKey = () => sessionStorage.getItem(KEY);

class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message ?? `HTTP ${status}`);
    this.status = status;
    this.details = body?.error?.details;
  }
}

async function api(method, path, body) {
  const res = await fetch(`/v1/admin${path}`, {
    method,
    headers: { authorization: `Bearer ${getKey()}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    sessionStorage.removeItem(KEY);
    render();
    throw new ApiError(401, { error: { message: "Invalid admin key" } });
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

function errorText(err) {
  const d = err.details;
  if (Array.isArray(d)) return `${err.message}: ${d.map((x) => `${x.path || "body"} ${x.message}`).join("; ")}`;
  if (d && typeof d === "object") return `${err.message}: ${JSON.stringify(d)}`;
  return err.message;
}

function notice(text, error = false) {
  return h("div", { class: `notice${error ? " error" : ""}`, role: error ? "alert" : "status", text });
}

function modal(title, content, { wide = false } = {}) {
  const dlg = h("dialog", { "aria-label": title }, h("div", { class: "top" }, h("h2", { text: title }), h("button", { class: "btn", type: "button", onclick: () => dlg.close(), text: "Close" })), content);
  if (wide) dlg.style.width = "min(900px, calc(100vw - 32px))";
  dlg.addEventListener("close", () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

function field(label, input, hint) {
  return h("label", {}, label, input, hint ? h("span", { class: "hint", text: hint }) : null);
}
const lines = (v) => v.split("\n").map((s) => s.trim()).filter(Boolean);
const csv = (v) => v.split(",").map((s) => s.trim()).filter(Boolean);

function copyButton(text) {
  const b = h("button", { class: "btn", type: "button", text: "Copy" });
  b.onclick = async () => {
    await navigator.clipboard.writeText(text);
    b.textContent = "Copied";
    setTimeout(() => (b.textContent = "Copy"), 1200);
  };
  return b;
}

// ------------------------------------------------------------------ login
function loginView() {
  const input = h("input", { type: "password", placeholder: "ea_admin_…", autocomplete: "off", "aria-label": "Admin key" });
  const msg = h("div");
  const form = h(
    "form",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        sessionStorage.setItem(KEY, input.value.trim());
        try {
          await api("GET", "/models");
          location.hash = "#/overview";
          render();
        } catch (err) {
          sessionStorage.removeItem(KEY);
          msg.replaceChildren(notice(errorText(err), true));
        }
      },
    },
    field("Admin key", input, "Printed by `pnpm seed`. Kept only in this browser tab."),
    msg,
    h("button", { class: "btn primary", type: "submit", text: "Sign in" }),
  );
  return h("div", { class: "login" }, h("div", { class: "card" }, h("h1", { text: "embed-assistant" }), h("p", { class: "muted", text: "Admin console" }), form));
}

// ------------------------------------------------------------------ views
const VIEWS = {
  overview: { title: "Overview", render: overview },
  assistants: { title: "Assistants", render: assistants },
  widgets: { title: "Widgets", render: widgets },
  knowledge: { title: "Knowledge", render: knowledge },
  conversations: { title: "Conversations", render: conversations },
};
let pollTimer = null;

async function overview(main) {
  const [usage, models] = await Promise.all([api("GET", "/usage?days=7"), api("GET", "/models")]);
  const stat = (k, v) => h("div", { class: "card stat" }, h("div", { class: "v", text: String(v) }), h("div", { class: "k", text: k }));
  const satisfaction = usage.feedbackUp + usage.feedbackDown ? `${Math.round((100 * usage.feedbackUp) / (usage.feedbackUp + usage.feedbackDown))}%` : "—";
  main.append(
    h("p", { class: "muted", text: "Last 7 days" }),
    h(
      "div",
      { class: "grid" },
      stat("Answers", usage.runs),
      stat("Failed", usage.failedRuns),
      stat("Tokens in / out", `${usage.inputTokens.toLocaleString()} / ${usage.outputTokens.toLocaleString()}`),
      stat("Helpful ratings", satisfaction),
      stat("Time to first token (p50)", usage.p50FirstTokenMs ? `${Math.round(usage.p50FirstTokenMs)} ms` : "—"),
      stat("Time to first token (p95)", usage.p95FirstTokenMs ? `${Math.round(usage.p95FirstTokenMs)} ms` : "—"),
    ),
    h(
      "div",
      { class: "card" },
      h("h2", { text: "Model aliases" }),
      h("p", { class: "muted small", text: "Assistants pick an alias. Deployments are tried in order; unavailable ones (no credentials) are skipped." }),
      h(
        "table",
        {},
        h("thead", {}, h("tr", {}, h("th", { text: "Alias" }), h("th", { text: "Deployments (in failover order)" }))),
        h(
          "tbody",
          {},
          models.map((m) =>
            h(
              "tr",
              {},
              h("td", {}, h("code", { text: m.alias })),
              h("td", {}, m.deployments.map((d) => h("span", { class: `badge ${d.available ? "ok" : ""}`, title: d.available ? "available" : "not configured", text: `${d.id} · ${d.model}` }), " ")),
            ),
          ),
        ),
      ),
    ),
  );
}

async function assistants(main) {
  const [list, sources, models] = await Promise.all([api("GET", "/assistants"), api("GET", "/sources"), api("GET", "/models")]);
  const edit = (a) => assistantForm(a, sources, models, () => route());
  main.append(
    h("div", { class: "row", style: "margin-bottom:12px" }, h("button", { class: "btn primary", onclick: () => edit(null), text: "New assistant" })),
    h(
      "div",
      { class: "card" },
      list.length
        ? h(
            "table",
            {},
            h("thead", {}, h("tr", {}, ["Name", "Model", "Knowledge", "Mode", "Updated", ""].map((t) => h("th", { text: t })))),
            h(
              "tbody",
              {},
              list.map((a) =>
                h(
                  "tr",
                  {},
                  h("td", {}, h("strong", { text: a.name }), h("div", { class: "muted small mono", text: a.id })),
                  h("td", {}, h("code", { text: a.modelAlias })),
                  h("td", { text: a.sourceIds.map((id) => sources.find((s) => s.id === id)?.name ?? id).join(", ") || "—" }),
                  h("td", { text: a.groundedOnly ? "Sources only" : "Sources + general" }),
                  h("td", { class: "small", text: fmtDate(a.updatedAt) }),
                  h(
                    "td",
                    { class: "row" },
                    h("button", { class: "btn", onclick: () => edit(a), text: "Edit" }),
                    h("button", {
                      class: "btn danger",
                      text: "Delete",
                      onclick: async () => {
                        if (!confirm(`Delete assistant "${a.name}" and its widgets?`)) return;
                        await api("DELETE", `/assistants/${a.id}`);
                        route();
                      },
                    }),
                  ),
                ),
              ),
            ),
          )
        : h("p", { class: "muted", text: "No assistants yet." }),
    ),
  );
}

function assistantForm(a, sources, models, done) {
  const f = {
    name: h("input", { value: a?.name ?? "", required: true, maxlength: 100 }),
    instructions: h("textarea", { value: a?.instructions ?? "", rows: 6, placeholder: "Tone, scope, what to do when unsure…" }),
    modelAlias: h("select", {}, models.map((m) => h("option", { value: m.alias, text: m.alias }))),
    greeting: h("input", { value: a?.greeting ?? "Hi! How can I help you today?" }),
    suggestions: h("textarea", { value: (a?.suggestions ?? []).join("\n"), rows: 3 }),
    placeholder: h("input", { value: a?.placeholder ?? "" }),
    disclaimer: h("input", { value: a?.disclaimer ?? "" }),
    groundedOnly: h("input", { type: "checkbox", checked: a ? a.groundedOnly : true }),
  };
  f.modelAlias.value = a?.modelAlias ?? "standard";
  const sourceChecks = sources.map((s) => {
    const c = h("input", { type: "checkbox", value: s.id, checked: a?.sourceIds.includes(s.id) });
    return h("label", { class: "check" }, c, `${s.name} `, h("span", { class: "badge", text: s.access.join(", ") }));
  });
  const msg = h("div");
  const form = h(
    "form",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        const body = {
          name: f.name.value.trim(),
          instructions: f.instructions.value,
          modelAlias: f.modelAlias.value,
          greeting: f.greeting.value,
          suggestions: lines(f.suggestions.value),
          placeholder: f.placeholder.value.trim() || null,
          disclaimer: f.disclaimer.value.trim() || null,
          sourceIds: sourceChecks.map((l) => l.querySelector("input")).filter((c) => c.checked).map((c) => c.value),
          groundedOnly: f.groundedOnly.checked,
        };
        try {
          await api(a ? "PATCH" : "POST", a ? `/assistants/${a.id}` : "/assistants", body);
          dlg.close();
          done();
        } catch (err) {
          msg.replaceChildren(notice(errorText(err), true));
        }
      },
    },
    field("Name", f.name),
    field("Instructions", f.instructions, "Added to the system prompt. Safety and citation rules are always applied."),
    h("div", { class: "two" }, field("Model alias", f.modelAlias), field("Greeting", f.greeting)),
    field("Suggested questions", f.suggestions, "One per line, up to 6."),
    h("div", { class: "two" }, field("Input placeholder", f.placeholder), field("Disclaimer", f.disclaimer)),
    h("fieldset", { style: "border:1px solid var(--border);border-radius:8px;padding:10px" }, h("legend", { text: "Knowledge sources" }), sourceChecks.length ? sourceChecks : h("span", { class: "muted", text: "No sources yet." })),
    h("label", { class: "check" }, f.groundedOnly, "Answer only from knowledge sources (recommended for support)"),
    msg,
    h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit", text: a ? "Save" : "Create" })),
  );
  const dlg = modal(a ? `Edit ${a.name}` : "New assistant", form);
}

async function widgets(main) {
  const [list, assistantsList] = await Promise.all([api("GET", "/widgets"), api("GET", "/assistants")]);
  const edit = (w) => widgetForm(w, assistantsList, () => route());
  main.append(
    h("div", { class: "row", style: "margin-bottom:12px" }, h("button", { class: "btn primary", disabled: !assistantsList.length, onclick: () => edit(null), text: "New widget" })),
    h(
      "div",
      { class: "card" },
      list.length
        ? h(
            "table",
            {},
            h("thead", {}, h("tr", {}, ["Name", "Assistant", "Allowed websites", ""].map((t) => h("th", { text: t })))),
            h(
              "tbody",
              {},
              list.map((w) =>
                h(
                  "tr",
                  {},
                  h("td", {}, h("strong", { text: w.name }), h("div", { class: "muted small mono", text: w.id })),
                  h("td", { text: assistantsList.find((a) => a.id === w.assistantId)?.name ?? w.assistantId }),
                  h("td", { class: "small" }, w.allowedOrigins.length ? w.allowedOrigins.join(", ") : h("span", { class: "badge bad", text: "none (blocked everywhere)" })),
                  h(
                    "td",
                    { class: "row" },
                    h("button", { class: "btn", onclick: () => showSnippet(w), text: "Embed" }),
                    h("a", { class: "btn", href: `/demo?widget=${encodeURIComponent(w.id)}`, target: "_blank", rel: "noopener", text: "Try" }),
                    h("button", { class: "btn", onclick: () => edit(w), text: "Edit" }),
                    h("button", {
                      class: "btn",
                      text: "Rotate secret",
                      onclick: async () => {
                        if (!confirm("Rotate the identity secret? User tokens signed with the old secret stop working immediately.")) return;
                        const r = await api("POST", `/widgets/${w.id}/rotate-secret`);
                        modal("New identity secret", secretBox(r.identitySecret));
                      },
                    }),
                    h("button", {
                      class: "btn danger",
                      text: "Delete",
                      onclick: async () => {
                        if (!confirm(`Delete widget "${w.name}"? Its conversations are deleted too.`)) return;
                        await api("DELETE", `/widgets/${w.id}`);
                        route();
                      },
                    }),
                  ),
                ),
              ),
            ),
          )
        : h("p", { class: "muted", text: assistantsList.length ? "No widgets yet." : "Create an assistant first." }),
    ),
  );
}

function secretBox(secret) {
  return h(
    "div",
    { class: "secret" },
    h("strong", { text: "Identity secret (shown once)" }),
    h("p", { class: "small muted", text: "Store it in your backend only. It signs the user tokens that tell the assistant who is signed in. Never put it in browser code." }),
    h("pre", { text: secret }),
    copyButton(secret),
  );
}

async function showSnippet(w) {
  const { html } = await api("GET", `/widgets/${w.id}/snippet`);
  modal(
    `Embed ${w.name}`,
    h(
      "div",
      {},
      h("p", { text: "Paste before </body> on any page of an allowed website:" }),
      h("pre", { text: html }),
      copyButton(html),
      h("p", { class: "small muted", text: "Optional attributes: data-locale, data-position, data-accent-color, data-mode, data-open, data-launcher=\"false\". JavaScript API: window.EmbedAssistant (open, close, toggle, ask, setContext, identify, on)." }),
    ),
  );
}

function widgetForm(w, assistantsList, done) {
  const f = {
    name: h("input", { value: w?.name ?? "", required: true }),
    assistantId: h("select", {}, assistantsList.map((a) => h("option", { value: a.id, text: a.name }))),
    origins: h("textarea", { value: (w?.allowedOrigins ?? [location.origin]).join("\n"), rows: 3 }),
    accent: h("input", { type: "color", value: w?.theme.accentColor ?? "#2563eb" }),
    mode: h("select", {}, ["auto", "light", "dark"].map((m) => h("option", { value: m, text: m }))),
    position: h("select", {}, ["bottom-right", "bottom-left"].map((m) => h("option", { value: m, text: m }))),
    radius: h("input", { type: "number", min: 0, max: 24, value: String(w?.theme.radius ?? 16) }),
    locale: h("input", { value: w?.defaultLocale ?? "", placeholder: "auto (visitor's browser)" }),
    budget: h("input", { type: "number", min: 1, value: w?.dailyTokenBudget ?? "", placeholder: "server default" }),
    feedback: h("input", { type: "checkbox", checked: w ? w.features.feedback : true }),
    sources: h("input", { type: "checkbox", checked: w ? w.features.sources : true }),
    history: h("input", { type: "checkbox", checked: w ? w.features.history : true }),
  };
  f.assistantId.value = w?.assistantId ?? assistantsList[0]?.id;
  f.mode.value = w?.theme.mode ?? "auto";
  f.position.value = w?.theme.position ?? "bottom-right";
  const msg = h("div");
  const form = h(
    "form",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        const body = {
          name: f.name.value.trim(),
          assistantId: f.assistantId.value,
          allowedOrigins: lines(f.origins.value).map((o) => (o === "*" ? o : o.replace(/\/+$/, ""))),
          theme: { accentColor: f.accent.value, mode: f.mode.value, position: f.position.value, radius: Number(f.radius.value) },
          defaultLocale: f.locale.value.trim() || null,
          dailyTokenBudget: f.budget.value ? Number(f.budget.value) : null,
          features: { feedback: f.feedback.checked, sources: f.sources.checked, history: f.history.checked },
        };
        try {
          const r = await api(w ? "PATCH" : "POST", w ? `/widgets/${w.id}` : "/widgets", body);
          dlg.close();
          done();
          if (!w) modal("Widget created", h("div", {}, h("p", { text: "Embed snippet:" }), h("pre", { text: r.embedSnippet }), copyButton(r.embedSnippet), secretBox(r.identitySecret)));
        } catch (err) {
          msg.replaceChildren(notice(errorText(err), true));
        }
      },
    },
    h("div", { class: "two" }, field("Name", f.name), field("Assistant", f.assistantId)),
    field("Allowed websites", f.origins, "One origin per line, e.g. https://www.example.com. Use * only for testing."),
    h("div", { class: "two" }, field("Accent color", f.accent), field("Theme", f.mode)),
    h("div", { class: "two" }, field("Position", f.position), field("Corner radius", f.radius)),
    h("div", { class: "two" }, field("Default UI language", f.locale), field("Daily token budget", f.budget)),
    h("div", { class: "row" }, h("label", { class: "check" }, f.feedback, "Feedback buttons"), h("label", { class: "check" }, f.sources, "Show sources"), h("label", { class: "check" }, f.history, "Conversation history")),
    msg,
    h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit", text: w ? "Save" : "Create" })),
  );
  const dlg = modal(w ? `Edit ${w.name}` : "New widget", form);
}

async function knowledge(main) {
  const list = await api("GET", "/sources");
  const badge = (s) => h("span", { class: `badge ${s === "succeeded" ? "ok" : s === "failed" ? "bad" : s === "idle" ? "" : "warn"}`, text: s });
  main.append(
    h("div", { class: "row", style: "margin-bottom:12px" }, h("button", { class: "btn primary", onclick: () => sourceForm(() => route()), text: "Add knowledge" })),
    h(
      "div",
      { class: "card" },
      list.length
        ? h(
            "table",
            {},
            h("thead", {}, h("tr", {}, ["Source", "Access", "Status", "Documents", "Last update", ""].map((t) => h("th", { text: t })))),
            h(
              "tbody",
              {},
              list.map((s) =>
                h(
                  "tr",
                  {},
                  h("td", {}, h("strong", { text: s.name }), h("div", { class: "muted small", text: s.url ? `${s.type}: ${s.url}` : s.type })),
                  h("td", {}, s.access.map((a) => h("span", { class: "badge", text: a }))),
                  h("td", {}, badge(s.status), s.lastError ? h("div", { class: "small muted", text: s.lastError }) : null),
                  h("td", { text: String(s.documentCount) }),
                  h("td", { class: "small", text: fmtDate(s.lastIngestedAt) }),
                  h(
                    "td",
                    { class: "row" },
                    h("button", { class: "btn", onclick: () => documentsDialog(s), text: "Documents" }),
                    s.type !== "manual"
                      ? h("button", {
                          class: "btn",
                          text: "Sync",
                          disabled: s.status === "queued" || s.status === "running",
                          onclick: async () => {
                            await api("POST", `/sources/${s.id}/sync`);
                            route();
                          },
                        })
                      : null,
                    h("button", {
                      class: "btn danger",
                      text: "Delete",
                      onclick: async () => {
                        if (!confirm(`Delete "${s.name}" and all its documents?`)) return;
                        await api("DELETE", `/sources/${s.id}`);
                        route();
                      },
                    }),
                  ),
                ),
              ),
            ),
          )
        : h("p", { class: "muted", text: "No knowledge yet. Add a website, a sitemap, or push documents through the API." }),
    ),
  );
  if (list.some((s) => s.status === "queued" || s.status === "running")) pollTimer = setTimeout(() => route(), 3000);
}

function sourceForm(done) {
  const f = {
    name: h("input", { required: true, placeholder: "Help center" }),
    type: h("select", {}, h("option", { value: "sitemap", text: "Sitemap (many pages)" }), h("option", { value: "url", text: "Single page" }), h("option", { value: "manual", text: "Manual / API push" })),
    url: h("input", { type: "url", placeholder: "https://example.com/sitemap.xml" }),
    access: h("input", { value: "public" }),
    maxPages: h("input", { type: "number", min: 1, max: 5000, value: "200" }),
  };
  const msg = h("div");
  const form = h(
    "form",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          await api("POST", "/sources", {
            name: f.name.value.trim(),
            type: f.type.value,
            url: f.type.value === "manual" ? null : f.url.value.trim(),
            access: csv(f.access.value),
            maxPages: Number(f.maxPages.value),
          });
          dlg.close();
          done();
        } catch (err) {
          msg.replaceChildren(notice(errorText(err), true));
        }
      },
    },
    h("div", { class: "two" }, field("Name", f.name), field("Type", f.type)),
    field("URL", f.url, "Sitemap or page URL. Ignored for manual sources."),
    h("div", { class: "two" }, field("Access tags", f.access, "public = everyone; users = any signed-in user; other tags = users whose token lists them in groups."), field("Max pages", f.maxPages)),
    msg,
    h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit", text: "Add" })),
  );
  const dlg = modal("Add knowledge", form);
}

async function documentsDialog(s) {
  const body = h("div", {}, h("p", { class: "muted", text: "Loading…" }));
  modal(`${s.name} · documents`, body, { wide: true });
  const load = async () => {
    const docs = await api("GET", `/sources/${s.id}/documents?limit=500`);
    const f = {
      title: h("input", { required: true }),
      url: h("input", { type: "url", placeholder: "optional" }),
      content: h("textarea", { required: true, rows: 8, placeholder: "Markdown or plain text" }),
    };
    const msg = h("div");
    body.replaceChildren(
      docs.length
        ? h(
            "table",
            {},
            h("thead", {}, h("tr", {}, ["Title", "Chunks", "Updated", ""].map((t) => h("th", { text: t })))),
            h(
              "tbody",
              {},
              docs.map((d) =>
                h(
                  "tr",
                  {},
                  h("td", {}, d.url ? h("a", { href: d.url, target: "_blank", rel: "noopener noreferrer", text: d.title }) : d.title),
                  h("td", { text: String(d.chunkCount) }),
                  h("td", { class: "small", text: fmtDate(d.updatedAt) }),
                  h("td", {}, h("button", {
                    class: "btn danger",
                    text: "Delete",
                    onclick: async () => {
                      await api("DELETE", `/sources/${s.id}/documents/${d.id}`);
                      load();
                    },
                  })),
                ),
              ),
            ),
          )
        : h("p", { class: "muted", text: "No documents." }),
      h("h2", { style: "margin-top:20px", text: "Add or replace a document" }),
      h(
        "form",
        {
          onsubmit: async (e) => {
            e.preventDefault();
            try {
              await api("PUT", `/sources/${s.id}/documents`, { title: f.title.value.trim(), url: f.url.value.trim() || null, content: f.content.value });
              load();
            } catch (err) {
              msg.replaceChildren(notice(errorText(err), true));
            }
          },
        },
        h("div", { class: "two" }, field("Title", f.title), field("URL", f.url)),
        field("Content", f.content),
        msg,
        h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit", text: "Save document" })),
      ),
    );
  };
  load().catch((err) => body.replaceChildren(notice(errorText(err), true)));
}

async function conversations(main) {
  const table = h("tbody");
  const more = h("button", { class: "btn", text: "Load more", hidden: true });
  let cursor = null;
  const load = async () => {
    const page = await api("GET", `/conversations?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    for (const c of page.items) {
      table.append(
        h(
          "tr",
          {},
          h("td", {}, h("button", { class: "btn", onclick: () => transcript(c), text: c.title || "(untitled)" })),
          h("td", {}, h("span", { class: "badge", text: c.subjectKind }), " ", h("span", { class: "small mono muted", text: c.subjectId.slice(0, 40) })),
          h("td", { text: String(c.messageCount) }),
          h("td", { class: "small", text: fmtDate(c.updatedAt) }),
        ),
      );
    }
    cursor = page.nextCursor;
    more.hidden = !cursor;
  };
  more.onclick = load;
  main.append(
    h("div", { class: "card" }, h("table", {}, h("thead", {}, h("tr", {}, ["Conversation", "Visitor", "Messages", "Last activity"].map((t) => h("th", { text: t })))), table), more),
  );
  await load();
  if (!table.children.length) table.append(h("tr", {}, h("td", { colspan: 4, class: "muted", text: "No conversations yet." })));
}

async function transcript(c) {
  const body = h("div", {}, h("p", { class: "muted", text: "Loading…" }));
  modal(c.title || "Conversation", body, { wide: true });
  const page = await api("GET", `/conversations/${c.id}/messages?limit=200`);
  body.replaceChildren(
    ...page.items.map((m) =>
      h(
        "div",
        { class: "msg" },
        h("div", { class: "who" }, m.role, m.feedback ? h("span", { class: `badge ${m.feedback === "up" ? "ok" : "bad"}`, text: m.feedback === "up" ? " helpful" : " not helpful" }) : null, m.status !== "complete" ? h("span", { class: "badge warn", text: m.status }) : null),
        h("div", { class: "body", text: m.content }),
        m.citations.length ? h("div", { class: "small muted", text: `Sources: ${m.citations.map((x) => `[${x.index}] ${x.title}`).join(" · ")}` }) : null,
      ),
    ),
  );
}

// ------------------------------------------------------------------ shell + router
async function route() {
  clearTimeout(pollTimer);
  const name = (location.hash.replace(/^#\//, "") || "overview").split("/")[0];
  const view = VIEWS[name] ?? VIEWS.overview;
  document.querySelectorAll("aside [data-view]").forEach((b) => b.setAttribute("aria-current", b.dataset.view === name ? "page" : "false"));
  const main = document.querySelector("main");
  if (!main) return;
  const content = h("div");
  main.replaceChildren(h("div", { class: "top" }, h("h1", { text: view.title })), content);
  document.title = `${view.title} · embed-assistant`;
  try {
    await view.render(content);
  } catch (err) {
    if (err.status !== 401) content.replaceChildren(notice(errorText(err), true));
  }
}

function render() {
  if (!getKey()) {
    app.replaceChildren(loginView());
    return;
  }
  const nav = Object.entries(VIEWS).map(([id, v]) => h("button", { "data-view": id, onclick: () => (location.hash = `#/${id}`), text: v.title }));
  app.replaceChildren(
    h(
      "div",
      { class: "layout" },
      h(
        "aside",
        {},
        h("div", { class: "brand", text: "embed-assistant" }),
        nav,
        h("div", { class: "spacer" }),
        h("a", { class: "small", href: "/openapi.json", target: "_blank", text: "API reference (OpenAPI)" }),
        h("button", {
          onclick: () => {
            sessionStorage.removeItem(KEY);
            render();
          },
          text: "Sign out",
        }),
      ),
      h("main"),
    ),
  );
  route();
}

window.addEventListener("hashchange", () => getKey() && route());
render();
