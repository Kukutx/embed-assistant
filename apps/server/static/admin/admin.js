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
  const form = body instanceof FormData;
  const res = await fetch(`/v1/admin${path}`, {
    method,
    headers: { authorization: `Bearer ${getKey()}`, ...(body !== undefined && !form ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : form ? body : JSON.stringify(body),
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
  insights: { title: "Insights", render: insights },
  assistants: { title: "Assistants", render: assistants },
  widgets: { title: "Widgets", render: widgets },
  knowledge: { title: "Knowledge", render: knowledge },
  actions: { title: "Actions", render: actions },
  mcp: { title: "MCP servers", render: mcpServers },
  conversations: { title: "Conversations", render: conversations },
  webhooks: { title: "Webhooks", render: webhooks },
  settings: { title: "Settings", render: settings },
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
  const [list, sources, models, actionList, mcpList] = await Promise.all([
    api("GET", "/assistants"),
    api("GET", "/sources"),
    api("GET", "/models"),
    api("GET", "/actions"),
    api("GET", "/mcp-servers"),
  ]);
  const edit = (a) => assistantForm(a, sources, models, actionList, mcpList, () => route());
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

function assistantForm(a, sources, models, actionList, mcpList, done) {
  const f = {
    name: h("input", { value: a?.name ?? "", required: true, maxlength: 100 }),
    instructions: h("textarea", { value: a?.instructions ?? "", rows: 6, placeholder: "Tone, scope, what to do when unsure…" }),
    modelAlias: h("select", {}, models.map((m) => h("option", { value: m.alias, text: m.alias }))),
    greeting: h("input", { value: a?.greeting ?? "Hi! How can I help you today?" }),
    suggestions: h("textarea", { value: (a?.suggestions ?? []).join("\n"), rows: 3 }),
    placeholder: h("input", { value: a?.placeholder ?? "" }),
    disclaimer: h("input", { value: a?.disclaimer ?? "" }),
    groundedOnly: h("input", { type: "checkbox", checked: a ? a.groundedOnly : true }),
    followUps: h("input", { type: "checkbox", checked: a ? a.followUps : true }),
    queryRewrite: h("input", { type: "checkbox", checked: a ? a.queryRewrite : true }),
    agenticSearch: h("input", { type: "checkbox", checked: a ? a.agenticSearch : true }),
    clientTools: h("input", { type: "checkbox", checked: a ? a.clientTools : true }),
    redactPii: h("input", { type: "checkbox", checked: a ? a.redactPii : false }),
    handoffEnabled: h("input", { type: "checkbox", checked: a?.handoff?.enabled ?? false }),
    handoffMessage: h("input", { value: a?.handoff?.message ?? "I've passed this conversation to our team. Someone will get back to you as soon as possible." }),
    handoffUrl: h("input", { value: a?.handoff?.url ?? "", placeholder: "https://example.com/contact (optional)" }),
    handoffLabel: h("input", { value: a?.handoff?.label ?? "", placeholder: "Talk to a person" }),
  };
  const actionChecks = actionList.map((x) => {
    const c = h("input", { type: "checkbox", value: x.id, checked: a?.actionIds?.includes(x.id) });
    return h("label", { class: "check" }, c, `${x.title} `, h("code", { text: x.name }), x.confirm ? h("span", { class: "badge warn", text: "asks first" }) : null, x.enabled ? null : h("span", { class: "badge", text: "disabled" }));
  });
  const mcpChecks = mcpList.map((x) => {
    const c = h("input", { type: "checkbox", value: x.id, checked: a?.mcpServerIds?.includes(x.id) });
    return h("label", { class: "check" }, c, `${x.title} `, h("span", { class: "muted small", text: `${x.tools.length} tools` }), x.lastError ? h("span", { class: "badge bad", text: "error" }) : null, x.enabled ? null : h("span", { class: "badge", text: "disabled" }));
  });
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
          mcpServerIds: mcpChecks.map((l) => l.querySelector("input")).filter((c) => c.checked).map((c) => c.value),
          actionIds: actionChecks.map((l) => l.querySelector("input")).filter((c) => c.checked).map((c) => c.value),
          followUps: f.followUps.checked,
          queryRewrite: f.queryRewrite.checked,
          agenticSearch: f.agenticSearch.checked,
          clientTools: f.clientTools.checked,
          redactPii: f.redactPii.checked,
          handoff: {
            enabled: f.handoffEnabled.checked,
            message: f.handoffMessage.value.trim() || "I've passed this conversation to our team.",
            url: f.handoffUrl.value.trim() || null,
            label: f.handoffLabel.value.trim() || null,
          },
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
    h("fieldset", { class: "box" }, h("legend", { text: "Knowledge sources" }), sourceChecks.length ? sourceChecks : h("span", { class: "muted", text: "No sources yet." })),
    h("label", { class: "check" }, f.groundedOnly, "Answer only from knowledge sources (recommended for support)"),
    h("fieldset", { class: "box" }, h("legend", { text: "Actions (tools)" }), actionChecks.length ? actionChecks : h("span", { class: "muted", text: "No actions yet. Create them under Actions." })),
    h("fieldset", { class: "box" }, h("legend", { text: "MCP servers" }), mcpChecks.length ? mcpChecks : h("span", { class: "muted", text: "None connected. Add them under MCP servers." })),
    h(
      "fieldset",
      { class: "box" },
      h("legend", { text: "Human handoff" }),
      h("label", { class: "check" }, f.handoffEnabled, "Offer “talk to a person” (delivered through the handoff.requested webhook)"),
      field("Message shown to the visitor", f.handoffMessage),
      h("div", { class: "two" }, field("Contact link", f.handoffUrl), field("Button label", f.handoffLabel)),
    ),
    h(
      "fieldset",
      { class: "box" },
      h("legend", { text: "Behaviour" }),
      h("label", { class: "check" }, f.followUps, "Suggest follow-up questions after answers"),
      h("label", { class: "check" }, f.queryRewrite, "Understand follow-up questions in context (query rewriting)"),
      h("label", { class: "check" }, f.agenticSearch, "Let the model run extra knowledge searches"),
      h("label", { class: "check" }, f.clientTools, "Accept tools registered by the host page"),
      h("label", { class: "check" }, f.redactPii, "Mask e-mails, phone numbers, card numbers and IBANs"),
    ),
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
                  h(
                    "td",
                    {},
                    h("strong", { text: s.name }),
                    h("div", { class: "muted small", text: s.url ? `${s.type}: ${s.url}` : s.type }),
                    s.syncIntervalHours ? h("div", { class: "muted small", text: `Re-syncs every ${s.syncIntervalHours} h` }) : null,
                  ),
                  h("td", {}, s.access.map((a) => h("span", { class: "badge", text: a }))),
                  h("td", {}, badge(s.status), s.lastError ? h("div", { class: "small muted", text: s.lastError }) : null),
                  h("td", { text: String(s.documentCount) }),
                  h("td", { class: "small", text: fmtDate(s.lastIngestedAt) }),
                  h(
                    "td",
                    { class: "row" },
                    h("button", { class: "btn", onclick: () => documentsDialog(s), text: "Documents" }),
                    s.type === "manual" ? h("button", { class: "btn", onclick: () => uploadDialog(s), text: "Upload files" }) : null,
                    h("button", { class: "btn", onclick: () => sourceEdit(s), text: "Edit" }),
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
    sync: syncSelect(null),
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
            syncIntervalHours: f.type.value === "manual" ? null : Number(f.sync.value) || null,
          });
          dlg.close();
          done();
        } catch (err) {
          msg.replaceChildren(notice(errorText(err), true));
        }
      },
    },
    h("div", { class: "two" }, field("Name", f.name), field("Type", f.type)),
    field("URL", f.url, "Sitemap (sitemap.xml), llms.txt index or page URL. Ignored for manual sources (add documents, upload files or push them through the API)."),
    h("div", { class: "two" }, field("Access tags", f.access, "public = everyone; users = any signed-in user; other tags = users whose token lists them in groups."), field("Max pages", f.maxPages)),
    field("Keep in sync", f.sync, "Crawled sources only."),
    msg,
    h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit", text: "Add" })),
  );
  const dlg = modal("Add knowledge", form);
}

const SYNC_OPTIONS = [[0, "Only when I click Sync"], [6, "Every 6 hours"], [24, "Daily"], [168, "Weekly"]];
function syncSelect(current) {
  const opts = SYNC_OPTIONS.some(([v]) => v === (current ?? 0)) ? SYNC_OPTIONS : [...SYNC_OPTIONS, [current, `Every ${current} hours`]];
  const sel = h("select", {}, opts.map(([v, t]) => h("option", { value: String(v), text: t })));
  sel.value = String(current ?? 0);
  return sel;
}

function sourceEdit(s) {
  const f = {
    name: h("input", { value: s.name, required: true }),
    url: h("input", { type: "url", value: s.url ?? "" }),
    access: h("input", { value: s.access.join(", ") }),
    maxPages: h("input", { type: "number", min: 1, max: 5000, value: String(s.maxPages) }),
    sync: syncSelect(s.syncIntervalHours),
  };
  const msg = h("div");
  const crawled = s.type !== "manual";
  const form = h(
    "form",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          const body = { name: f.name.value.trim(), access: csv(f.access.value) };
          if (crawled) Object.assign(body, { url: f.url.value.trim(), maxPages: Number(f.maxPages.value), syncIntervalHours: Number(f.sync.value) || null });
          await api("PATCH", `/sources/${s.id}`, body);
          dlg.close();
          route();
        } catch (err) {
          msg.replaceChildren(notice(errorText(err), true));
        }
      },
    },
    field("Name", f.name),
    crawled ? field("URL", f.url) : null,
    field("Access tags", f.access, "Changing tags applies to all stored documents immediately."),
    crawled ? h("div", { class: "two" }, field("Max pages", f.maxPages), field("Keep in sync", f.sync)) : null,
    msg,
    h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit", text: "Save" })),
  );
  const dlg = modal(`Edit ${s.name}`, form);
}

function uploadDialog(s) {
  const input = h("input", { type: "file", multiple: true, accept: ".pdf,.docx,.md,.markdown,.txt,.html,.htm,.csv,.json" });
  const out = h("div");
  const btn = h("button", { class: "btn primary", type: "submit", text: "Upload" });
  const form = h(
    "form",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        if (!input.files.length) return;
        const fd = new FormData();
        for (const file of input.files) fd.append("file", file);
        btn.disabled = true;
        out.replaceChildren(h("p", { class: "muted", text: `Reading ${input.files.length} file(s)…` }));
        try {
          const { results } = await api("POST", `/sources/${s.id}/files`, fd);
          out.replaceChildren(
            h(
              "table",
              {},
              h("tbody", {}, results.map((r) =>
                h("tr", {}, h("td", { text: r.name }), h("td", {}, r.error ? h("span", { class: "bad", text: r.error }) : h("span", { class: "badge ok", text: r.changed ? "added" : "unchanged" })), h("td", { class: "small muted", text: r.title ?? "" })),
              )),
            ),
          );
        } catch (err) {
          out.replaceChildren(notice(errorText(err), true));
        } finally {
          btn.disabled = false;
        }
      },
    },
    field("Files", input, "PDF, Word (.docx), Markdown, HTML or text, up to 20 MB each. A file with the same name replaces the earlier version. Scanned PDFs need OCR first."),
    h("div", { class: "row" }, btn),
    out,
  );
  const dlg = modal(`Upload to ${s.name}`, form, { wide: true });
  dlg.addEventListener("close", () => route());
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
          h("td", {}, h("button", { class: "btn", onclick: () => transcript(c), text: c.title || "(untitled)" }), c.handoffRequestedAt ? h("span", { class: "badge warn", text: " handoff" }) : null),
          h("td", {}, h("span", { class: "badge", text: c.subjectKind }), " ", h("span", { class: "small mono muted", text: c.subjectId.slice(0, 40) })),
          h("td", { text: String(c.messageCount) }),
          h("td", { class: "small", text: fmtDate(c.updatedAt) }),
          h(
            "td",
            {},
            h("button", {
              class: "btn danger",
              text: "Delete",
              onclick: async (e) => {
                if (!confirm("Delete this conversation permanently?")) return;
                await api("DELETE", `/conversations/${c.id}`);
                e.target.closest("tr").remove();
              },
            }),
          ),
        ),
      );
    }
    cursor = page.nextCursor;
    more.hidden = !cursor;
  };
  more.onclick = load;
  main.append(
    h("div", { class: "row", style: "margin-bottom:12px" }, h("button", { class: "btn", text: "Export last 30 days (NDJSON)", onclick: () => download("/conversations/export?days=30", "conversations.ndjson") })),
    h("div", { class: "card" }, h("table", {}, h("thead", {}, h("tr", {}, ["Conversation", "Visitor", "Messages", "Last activity", ""].map((t) => h("th", { text: t })))), table), more),
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

async function download(path, filename) {
  const res = await fetch(`/v1/admin${path}`, { headers: { authorization: `Bearer ${getKey()}` } });
  if (!res.ok) return alert(`Export failed (HTTP ${res.status})`);
  const url = URL.createObjectURL(await res.blob());
  const a = h("a", { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ------------------------------------------------------------------ insights
async function insights(main) {
  const days = Number(new URLSearchParams(location.hash.split("?")[1] ?? "").get("days") ?? 30);
  const ins = await api("GET", `/insights?days=${days}`);
  const stat = (k, v) => h("div", { class: "card stat" }, h("div", { class: "v", text: String(v) }), h("div", { class: "k", text: k }));
  const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : "—");
  const list = (title, hint, rows, empty) =>
    h(
      "div",
      { class: "card" },
      h("h2", { text: title }),
      hint ? h("p", { class: "muted small", text: hint }) : null,
      rows.length ? h("table", {}, h("tbody", {}, rows)) : h("p", { class: "muted", text: empty }),
    );
  main.append(
    h("div", { class: "row", style: "margin-bottom:12px" }, ...[7, 30, 90].map((d) => h("button", { class: `btn${d === days ? " primary" : ""}`, text: `${d} days`, onclick: () => (location.hash = `#/insights?days=${d}`) }))),
    h(
      "div",
      { class: "grid", style: "margin-bottom:16px" },
      stat("Conversations", ins.conversations),
      stat("Questions", ins.questions),
      stat("Answered from knowledge", pct(ins.questions - ins.unanswered, ins.questions)),
      stat("Handoffs to people", `${ins.handoffs} (${pct(ins.handoffs, ins.conversations)})`),
      stat("Satisfaction", ins.satisfaction === null ? "—" : `${Math.round(ins.satisfaction * 100)}%`),
      stat("Ratings", `${ins.feedbackUp} 👍 · ${ins.feedbackDown} 👎`),
    ),
    list(
      "Knowledge gaps",
      "Questions for which no relevant knowledge was found. Writing or fixing these docs improves answers the most.",
      ins.knowledgeGaps.map((q) => h("tr", {}, h("td", { text: q.question }), h("td", { class: "small muted", text: `${q.count}×` }), h("td", { class: "small muted", text: fmtDate(q.lastAskedAt) }))),
      "No gaps in this period.",
    ),
    list(
      "Answers rated not helpful",
      null,
      ins.downvoted.map((d) =>
        h(
          "tr",
          {},
          h("td", {}, h("strong", { text: d.question || "(question not found)" }), h("div", { class: "small muted clamp", text: d.answer }), d.comment ? h("div", { class: "small", text: `“${d.comment}”` }) : null),
          h("td", { class: "small muted", text: fmtDate(d.createdAt) }),
        ),
      ),
      "No negative ratings in this period.",
    ),
    list(
      "Top questions",
      null,
      ins.topQuestions.map((q) => h("tr", {}, h("td", { text: q.question }), h("td", { class: "small muted", text: `${q.count}×` }))),
      "No questions yet.",
    ),
    list(
      "Tools",
      null,
      ins.tools.map((t) => h("tr", {}, h("td", {}, h("code", { text: t.name })), h("td", { class: "small", text: `${t.calls} calls` }), h("td", { class: `small${t.errors ? " bad" : " muted"}`, text: `${t.errors} errors` }))),
      "No tool calls in this period.",
    ),
  );
}

// ------------------------------------------------------------------ actions
async function actions(main) {
  const list = await api("GET", "/actions");
  main.append(
    h("p", { class: "muted", text: "HTTP endpoints the assistant can call as tools: look up an order, create a ticket, book a demo. Requests are signed (EA-Signature) with the widget identity secret." }),
    h("div", { class: "row", style: "margin-bottom:12px" }, h("button", { class: "btn primary", onclick: () => actionForm(null), text: "New action" })),
    h(
      "div",
      { class: "card" },
      list.length
        ? h(
            "table",
            {},
            h("thead", {}, h("tr", {}, ["Action", "Request", "Rules", ""].map((t) => h("th", { text: t })))),
            h(
              "tbody",
              {},
              list.map((x) =>
                h(
                  "tr",
                  {},
                  h("td", {}, h("strong", { text: x.title }), h("div", {}, h("code", { text: x.name })), h("div", { class: "small muted", text: x.description })),
                  h("td", { class: "small mono", text: `${x.method} ${x.url}` }),
                  h("td", {}, x.enabled ? null : h("span", { class: "badge", text: "disabled" }), x.confirm ? h("span", { class: "badge warn", text: "asks first" }) : null, x.requireUser ? h("span", { class: "badge", text: "signed-in only" }) : null),
                  h(
                    "td",
                    { class: "row" },
                    h("button", { class: "btn", onclick: () => actionForm(x), text: "Edit" }),
                    h("button", { class: "btn", onclick: () => actionTest(x), text: "Test" }),
                    h("button", {
                      class: "btn danger",
                      text: "Delete",
                      onclick: async () => {
                        if (!confirm(`Delete action "${x.title}"?`)) return;
                        await api("DELETE", `/actions/${x.id}`);
                        route();
                      },
                    }),
                  ),
                ),
              ),
            ),
          )
        : h("p", { class: "muted", text: "No actions yet." }),
    ),
  );
}

function actionForm(x) {
  const f = {
    name: h("input", { value: x?.name ?? "", required: true, pattern: "[a-zA-Z][a-zA-Z0-9_-]{0,63}", placeholder: "get_order_status" }),
    title: h("input", { value: x?.title ?? "", required: true, placeholder: "Checking your order" }),
    description: h("textarea", { value: x?.description ?? "", rows: 3, required: true, placeholder: "When the model should use it, and what it returns." }),
    method: h("select", {}, ["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => h("option", { value: m, text: m }))),
    url: h("input", { value: x?.url ?? "", required: true, placeholder: "https://api.example.com/orders/{orderId}" }),
    parameters: h("textarea", { class: "mono", rows: 7, value: JSON.stringify(x?.parameters ?? { type: "object", properties: { orderId: { type: "string", description: "Order number" } }, required: ["orderId"] }, null, 2) }),
    headers: h("textarea", { class: "mono", rows: 3, value: "", placeholder: x?.headerNames?.length ? `Configured: ${x.headerNames.join(", ")}. Leave empty to keep.` : '{ "Authorization": "Bearer …" }' }),
    timeoutMs: h("input", { type: "number", min: 1000, max: 30000, value: x?.timeoutMs ?? 10000 }),
    confirm: h("input", { type: "checkbox", checked: x?.confirm ?? false }),
    requireUser: h("input", { type: "checkbox", checked: x?.requireUser ?? false }),
    enabled: h("input", { type: "checkbox", checked: x?.enabled ?? true }),
  };
  f.method.value = x?.method ?? "POST";
  const msg = h("div");
  const form = h(
    "form",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          const body = {
            name: f.name.value.trim(),
            title: f.title.value.trim(),
            description: f.description.value.trim(),
            method: f.method.value,
            url: f.url.value.trim(),
            parameters: JSON.parse(f.parameters.value || "{}"),
            timeoutMs: Number(f.timeoutMs.value),
            confirm: f.confirm.checked,
            requireUser: f.requireUser.checked,
            enabled: f.enabled.checked,
          };
          if (f.headers.value.trim()) body.headers = JSON.parse(f.headers.value);
          await api(x ? "PATCH" : "POST", x ? `/actions/${x.id}` : "/actions", body);
          dlg.close();
          route();
        } catch (err) {
          msg.replaceChildren(notice(err instanceof SyntaxError ? `Invalid JSON: ${err.message}` : errorText(err), true));
        }
      },
    },
    h("div", { class: "two" }, field("Tool name", f.name, "What the model calls."), field("Label", f.title, "Shown to visitors while it runs.")),
    field("Description", f.description),
    h("div", { class: "two" }, field("Method", f.method), field("Timeout (ms)", f.timeoutMs)),
    field("URL", f.url, "{name} placeholders are filled from arguments. Other arguments go to the query string (GET, DELETE) or the JSON body."),
    field("Parameters (JSON Schema)", f.parameters),
    field("Headers (JSON, stored encrypted)", f.headers),
    h("label", { class: "check" }, f.confirm, "Ask the visitor before each call (use for anything that changes data)"),
    h("label", { class: "check" }, f.requireUser, "Signed-in users only; forward their identity as EA-User-* headers"),
    h("label", { class: "check" }, f.enabled, "Enabled"),
    msg,
    h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit", text: x ? "Save" : "Create" })),
  );
  const dlg = modal(x ? `Edit ${x.title}` : "New action", form, { wide: true });
}

function actionTest(x) {
  const args = h("textarea", { class: "mono", rows: 5, value: "{}" });
  const out = h("div");
  const form = h(
    "form",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          const r = await api("POST", `/actions/${x.id}/test`, { arguments: JSON.parse(args.value || "{}") });
          out.replaceChildren(h("p", {}, h("span", { class: `badge ${r.isError ? "bad" : "ok"}`, text: `HTTP ${r.status}` }), ` ${r.durationMs} ms`), h("pre", { text: r.output }));
        } catch (err) {
          out.replaceChildren(notice(err instanceof SyntaxError ? `Invalid JSON: ${err.message}` : errorText(err), true));
        }
      },
    },
    field("Arguments (JSON)", args),
    h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit", text: "Call" })),
    out,
  );
  modal(`Test ${x.title}`, form, { wide: true });
}

// ------------------------------------------------------------------ MCP servers
async function mcpServers(main) {
  const list = await api("GET", "/mcp-servers");
  const endpoint = `${location.origin}/mcp`;
  main.append(
    h(
      "div",
      { class: "card" },
      h("h2", { text: "Use this knowledge from other AI tools" }),
      h("p", { class: "muted", text: "This server is itself an MCP server (Streamable HTTP, protocol 2026-07-28 and 2025-xx). Create an API key with the mcp scope under Settings, then add it to your MCP client:" }),
      h("pre", { text: JSON.stringify({ mcpServers: { "embed-assistant": { type: "http", url: endpoint, headers: { Authorization: "Bearer ea_mcp_…" } } } }, null, 2) }),
      h("p", { class: "small muted", text: "Tools: search_knowledge, ask, get_document, list_sources. The key's access tags decide which knowledge it can read." }),
    ),
    h("h2", { text: "Connected MCP servers" }),
    h("p", { class: "muted", text: "Give assistants the tools of remote MCP servers (ticketing, CRM, booking, internal APIs). Attach a server to an assistant under Assistants." }),
    h("div", { class: "row", style: "margin-bottom:12px" }, h("button", { class: "btn primary", onclick: () => mcpForm(null), text: "Connect MCP server" })),
    h(
      "div",
      { class: "card" },
      list.length
        ? h(
            "table",
            {},
            h("thead", {}, h("tr", {}, ["Server", "Tools", "Status", ""].map((t) => h("th", { text: t })))),
            h(
              "tbody",
              {},
              list.map((x) =>
                h(
                  "tr",
                  {},
                  h("td", {}, h("strong", { text: x.title }), h("div", {}, h("code", { text: x.name })), h("div", { class: "small muted mono", text: x.url })),
                  h(
                    "td",
                    { class: "small" },
                    x.tools.length
                      ? x.tools.map((t) => {
                          const off = x.allowedTools && !x.allowedTools.includes(t.name);
                          return h("div", { class: off ? "muted" : "" }, h("code", { text: t.name }), t.readOnly ? h("span", { class: "badge", text: "read-only" }) : null, off ? " (hidden)" : "");
                        })
                      : h("span", { class: "muted", text: "—" }),
                  ),
                  h(
                    "td",
                    { class: "small" },
                    x.lastError ? h("div", { class: "bad clamp", text: x.lastError }) : h("span", { class: "badge ok", text: x.protocolVersion ?? "ok" }),
                    x.enabled ? null : h("span", { class: "badge", text: "disabled" }),
                    x.confirm ? h("span", { class: "badge warn", text: "asks first" }) : null,
                    x.requireUser ? h("span", { class: "badge", text: "signed-in only" }) : null,
                    h("div", { class: "muted", text: x.refreshedAt ? `Checked ${fmtDate(x.refreshedAt)}` : "" }),
                  ),
                  h(
                    "td",
                    { class: "row" },
                    h("button", { class: "btn", onclick: () => mcpForm(x), text: "Edit" }),
                    h("button", {
                      class: "btn",
                      text: "Refresh",
                      onclick: async (e) => {
                        e.target.disabled = true;
                        await api("POST", `/mcp-servers/${x.id}/refresh`).finally(() => route());
                      },
                    }),
                    h("button", { class: "btn", disabled: !x.tools.length, onclick: () => mcpTest(x), text: "Test" }),
                    h("button", {
                      class: "btn danger",
                      text: "Remove",
                      onclick: async () => {
                        if (!confirm(`Remove MCP server "${x.title}"?`)) return;
                        await api("DELETE", `/mcp-servers/${x.id}`);
                        route();
                      },
                    }),
                  ),
                ),
              ),
            ),
          )
        : h("p", { class: "muted", text: "No MCP servers connected." }),
    ),
  );
}

function mcpForm(x) {
  const f = {
    name: h("input", { value: x?.name ?? "", required: true, pattern: "[a-z][a-z0-9_]{0,23}", placeholder: "helpdesk" }),
    title: h("input", { value: x?.title ?? "", required: true, placeholder: "Helpdesk" }),
    url: h("input", { value: x?.url ?? "", required: true, placeholder: "https://mcp.example.com/mcp" }),
    headers: h("textarea", { class: "mono", rows: 3, value: "", placeholder: x?.headerNames?.length ? `Configured: ${x.headerNames.join(", ")}. Leave empty to keep.` : '{ "Authorization": "Bearer …" }' }),
    allowedTools: h("input", { value: x?.allowedTools?.join(", ") ?? "", placeholder: "All tools" }),
    confirm: h("input", { type: "checkbox", checked: x?.confirm ?? true }),
    requireUser: h("input", { type: "checkbox", checked: x?.requireUser ?? false }),
    enabled: h("input", { type: "checkbox", checked: x?.enabled ?? true }),
  };
  const msg = h("div");
  const form = h(
    "form",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          const allowed = f.allowedTools.value.split(",").map((t) => t.trim()).filter(Boolean);
          const body = {
            name: f.name.value.trim(),
            title: f.title.value.trim(),
            url: f.url.value.trim(),
            allowedTools: allowed.length ? allowed : null,
            confirm: f.confirm.checked,
            requireUser: f.requireUser.checked,
            enabled: f.enabled.checked,
          };
          if (f.headers.value.trim()) body.headers = JSON.parse(f.headers.value);
          const saved = await api(x ? "PATCH" : "POST", x ? `/mcp-servers/${x.id}` : "/mcp-servers", body);
          if (saved.lastError) {
            msg.replaceChildren(notice(`Saved, but connecting failed: ${saved.lastError}`, true));
            x = saved;
            return;
          }
          dlg.close();
          route();
        } catch (err) {
          msg.replaceChildren(notice(err instanceof SyntaxError ? `Invalid JSON: ${err.message}` : errorText(err), true));
        }
      },
    },
    h("div", { class: "two" }, field("Name", f.name, "Prefix of its tools: name__tool."), field("Label", f.title)),
    field("URL (Streamable HTTP endpoint)", f.url),
    field("Headers (JSON, stored encrypted)", f.headers, "For example an API key or bearer token for the server."),
    field("Allowed tools", f.allowedTools, "Comma-separated tool names. Empty exposes every tool the server lists."),
    h("label", { class: "check" }, f.confirm, "Ask the visitor before each call (tools the server marks read-only run directly)"),
    h("label", { class: "check" }, f.requireUser, "Signed-in users only"),
    h("label", { class: "check" }, f.enabled, "Enabled"),
    msg,
    h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit", text: x ? "Save" : "Connect" })),
  );
  const dlg = modal(x ? `Edit ${x.title}` : "Connect MCP server", form, { wide: true });
}

function mcpTest(x) {
  const tool = h("select", {}, x.tools.map((t) => h("option", { value: t.name, text: t.name })));
  const args = h("textarea", { class: "mono", rows: 5, value: "{}" });
  const schema = h("pre", { class: "small", style: "max-height:200px" });
  const showSchema = () => (schema.textContent = JSON.stringify(x.tools.find((t) => t.name === tool.value)?.inputSchema ?? {}, null, 2));
  tool.addEventListener("change", showSchema);
  showSchema();
  const out = h("div");
  const form = h(
    "form",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          const r = await api("POST", `/mcp-servers/${x.id}/test`, { tool: tool.value, arguments: JSON.parse(args.value || "{}") });
          out.replaceChildren(h("p", {}, h("span", { class: `badge ${r.isError ? "bad" : "ok"}`, text: r.isError ? "error" : "ok" }), ` ${r.durationMs} ms`), h("pre", { text: r.output }));
        } catch (err) {
          out.replaceChildren(notice(err instanceof SyntaxError ? `Invalid JSON: ${err.message}` : errorText(err), true));
        }
      },
    },
    field("Tool", tool),
    schema,
    field("Arguments (JSON)", args),
    h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit", text: "Call" })),
    out,
  );
  modal(`Test ${x.title}`, form, { wide: true });
}

// ------------------------------------------------------------------ webhooks
const WEBHOOK_EVENTS = ["conversation.created", "message.completed", "feedback.submitted", "handoff.requested", "source.synced"];

async function webhooks(main) {
  const list = await api("GET", "/webhooks");
  main.append(
    h("p", { class: "muted", text: "Send events to your helpdesk, CRM, chat or automation tool. Signed per the Standard Webhooks spec; failed deliveries are retried for about 4 hours." }),
    h("div", { class: "row", style: "margin-bottom:12px" }, h("button", { class: "btn primary", onclick: () => webhookForm(null), text: "New webhook" })),
    h(
      "div",
      { class: "card" },
      list.length
        ? h(
            "table",
            {},
            h("thead", {}, h("tr", {}, ["Endpoint", "Events", ""].map((t) => h("th", { text: t })))),
            h(
              "tbody",
              {},
              list.map((w) =>
                h(
                  "tr",
                  {},
                  h("td", {}, h("div", { class: "mono small", text: w.url }), w.description ? h("div", { class: "small muted", text: w.description }) : null, w.enabled ? null : h("span", { class: "badge", text: "disabled" })),
                  h("td", {}, w.events.map((e) => h("span", { class: "badge", text: e }))),
                  h(
                    "td",
                    { class: "row" },
                    h("button", { class: "btn", onclick: () => webhookForm(w), text: "Edit" }),
                    h("button", {
                      class: "btn",
                      text: "Send test",
                      onclick: async (e) => {
                        const r = await api("POST", `/webhooks/${w.id}/test`);
                        e.target.textContent = r.ok ? `OK (${r.status})` : `Failed: ${r.error ?? r.status}`;
                      },
                    }),
                    h("button", { class: "btn", onclick: () => deliveries(w), text: "Deliveries" }),
                    h("button", {
                      class: "btn danger",
                      text: "Delete",
                      onclick: async () => {
                        if (!confirm("Delete this webhook?")) return;
                        await api("DELETE", `/webhooks/${w.id}`);
                        route();
                      },
                    }),
                  ),
                ),
              ),
            ),
          )
        : h("p", { class: "muted", text: "No webhooks yet." }),
    ),
  );
}

function webhookForm(w) {
  const url = h("input", { value: w?.url ?? "", required: true, placeholder: "https://hooks.example.com/assistant" });
  const description = h("input", { value: w?.description ?? "" });
  const enabled = h("input", { type: "checkbox", checked: w?.enabled ?? true });
  const checks = WEBHOOK_EVENTS.map((e) => h("label", { class: "check" }, h("input", { type: "checkbox", value: e, checked: w ? w.events.includes(e) : e === "handoff.requested" }), h("code", { text: e })));
  const msg = h("div");
  const form = h(
    "form",
    {
      onsubmit: async (ev) => {
        ev.preventDefault();
        const body = { url: url.value.trim(), description: description.value, enabled: enabled.checked, events: checks.map((l) => l.querySelector("input")).filter((c) => c.checked).map((c) => c.value) };
        try {
          const r = await api(w ? "PATCH" : "POST", w ? `/webhooks/${w.id}` : "/webhooks", body);
          if (!w) form.replaceChildren(h("p", { text: "Webhook created. Verify deliveries with this signing secret:" }), secretBox(r.secret), h("button", { class: "btn", type: "button", text: "Done", onclick: () => (dlg.close(), route()) }));
          else (dlg.close(), route());
        } catch (err) {
          msg.replaceChildren(notice(errorText(err), true));
        }
      },
    },
    field("Endpoint URL", url),
    field("Description", description),
    h("fieldset", { class: "box" }, h("legend", { text: "Events" }), checks),
    h("label", { class: "check" }, enabled, "Enabled"),
    msg,
    h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit", text: w ? "Save" : "Create" })),
  );
  const dlg = modal(w ? "Edit webhook" : "New webhook", form);
}

async function deliveries(w) {
  const body = h("div", {}, h("p", { class: "muted", text: "Loading…" }));
  modal("Recent deliveries", body, { wide: true });
  const rows = await api("GET", `/webhooks/${w.id}/deliveries`);
  body.replaceChildren(
    rows.length
      ? h(
          "table",
          {},
          h("thead", {}, h("tr", {}, ["Event", "Status", "Attempts", "Last error", "Created"].map((t) => h("th", { text: t })))),
          h("tbody", {}, rows.map((d) => h("tr", {}, h("td", {}, h("code", { text: d.event })), h("td", {}, h("span", { class: `badge ${d.status === "succeeded" ? "ok" : d.status === "failed" ? "bad" : "warn"}`, text: d.status })), h("td", { text: String(d.attempts) }), h("td", { class: "small", text: d.lastError ?? "" }), h("td", { class: "small", text: fmtDate(d.createdAt) })))),
        )
      : h("p", { class: "muted", text: "No deliveries yet." }),
  );
}

// ------------------------------------------------------------------ settings
async function settings(main) {
  const [st, keys] = await Promise.all([api("GET", "/settings"), api("GET", "/keys")]);
  const retention = h("input", { type: "number", min: 1, max: 3650, value: st.retentionDays ?? "", placeholder: "Keep forever" });
  const budget = h("input", { type: "number", min: 1, value: st.dailyTokenBudget ?? "", placeholder: "Server default" });
  const msg = h("div");
  const keyRows = h("tbody");
  for (const k of keys) {
    keyRows.append(
      h(
        "tr",
        {},
        h("td", {}, h("strong", { text: k.name }), h("div", { class: "small mono muted", text: `${k.prefix}…` })),
        h("td", {}, k.scopes.map((x) => h("span", { class: "badge", text: x })), k.scopes.includes("mcp") ? h("div", { class: "small muted", text: `access: ${k.access.join(", ")}` }) : null),
        h("td", { class: "small", text: k.lastUsedAt ? fmtDate(k.lastUsedAt) : "never" }),
        h("td", {}, h("button", { class: "btn danger", text: "Revoke", onclick: async () => { if (!confirm(`Revoke "${k.name}"?`)) return; try { await api("DELETE", `/keys/${k.id}`); route(); } catch (err) { alert(errorText(err)); } } })),
      ),
    );
  }
  const newName = h("input", { placeholder: "Key name", required: true });
  const newScope = h("select", {}, h("option", { value: "admin", text: "admin: full admin API" }), h("option", { value: "mcp", text: "mcp: MCP endpoint only (read knowledge, ask)" }));
  const newAccess = h("input", { value: "public", placeholder: "public, users, staff" });
  const keyMsg = h("div");
  main.append(
    h(
      "div",
      { class: "card" },
      h("h2", { text: "Data and usage" }),
      h(
        "form",
        {
          onsubmit: async (e) => {
            e.preventDefault();
            try {
              await api("PATCH", "/settings", { retentionDays: retention.value ? Number(retention.value) : null, dailyTokenBudget: budget.value ? Number(budget.value) : null });
              msg.replaceChildren(notice("Saved."));
            } catch (err) {
              msg.replaceChildren(notice(errorText(err), true));
            }
          },
        },
        h("div", { class: "two" }, field("Delete conversations after (days)", retention, "Empty keeps them forever. Deletion is permanent."), field("Daily model-token budget", budget, "Shared by widgets without their own budget.")),
        msg,
        h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit", text: "Save" })),
      ),
    ),
    h(
      "div",
      { class: "card" },
      h("h2", { text: "API keys" }),
      h("table", {}, h("thead", {}, h("tr", {}, ["Name", "Scope", "Last used", ""].map((t) => h("th", { text: t })))), keyRows),
      h(
        "form",
        {
          style: "margin-top:12px",
          onsubmit: async (e) => {
            e.preventDefault();
            try {
              const r = await api("POST", "/keys", { name: newName.value.trim(), scopes: [newScope.value], access: csv(newAccess.value) });
              keyMsg.replaceChildren(h("p", { text: "Key created. It is shown only once:" }), secretBox(r.key), h("button", { class: "btn", type: "button", text: "Done", onclick: () => route() }));
            } catch (err) {
              keyMsg.replaceChildren(notice(errorText(err), true));
            }
          },
        },
        h("div", { class: "two" }, field("Name", newName), field("Scope", newScope)),
        field("Knowledge access (mcp keys)", newAccess, "Comma-separated access tags the key may read."),
        keyMsg,
        h("div", { class: "row" }, h("button", { class: "btn", type: "submit", text: "Create key" })),
      ),
    ),
    h(
      "div",
      { class: "card" },
      h("h2", { text: "Erase a visitor's data" }),
      (() => {
        const subject = h("input", { placeholder: "user:123 or anon:…" });
        const out = h("div");
        return h(
          "form",
          {
            onsubmit: async (e) => {
              e.preventDefault();
              if (!subject.value.trim() || !confirm(`Delete every conversation of ${subject.value.trim()}?`)) return;
              const r = await api("DELETE", `/subjects/${encodeURIComponent(subject.value.trim())}`);
              out.replaceChildren(notice(`Deleted ${r.deletedConversations} conversation(s).`));
            },
          },
          field("Subject id", subject, "Shown in Conversations. Signed-in users are user:<sub> from your token."),
          out,
          h("div", { class: "row" }, h("button", { class: "btn danger", type: "submit", text: "Erase" })),
        );
      })(),
    ),
  );
}

// ------------------------------------------------------------------ shell + router
async function route() {
  clearTimeout(pollTimer);
  const name = (location.hash.replace(/^#\//, "") || "overview").split(/[/?]/)[0];
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
