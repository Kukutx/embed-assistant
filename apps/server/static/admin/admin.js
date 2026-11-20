// embed-assistant admin console. Plain ES module, no build step; talks only to /v1/admin/*.
const KEY = "embed-assistant-admin-key";
const app = document.getElementById("app");

// ------------------------------------------------------------------ language
// English is written in the code; i18n/<lang>.json maps each English text to its translation.
// Missing entries fall back to English, so a partial translation never breaks the console.
const LANGS = { en: "English", it: "Italiano", zh: "中文" };
const LANG_KEY = "embed-assistant-admin-lang";
const LANG = (() => {
  let saved = null;
  try { saved = localStorage.getItem(LANG_KEY); } catch {}
  if (saved && LANGS[saved]) return saved;
  for (const l of navigator.languages ?? [navigator.language]) {
    const base = String(l).toLowerCase().split("-")[0];
    if (LANGS[base]) return base;
  }
  return "en";
})();
const CATALOG = LANG === "en" ? {} : await fetch(`./i18n/${LANG}.json`).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
document.documentElement.lang = LANG;
/** Translate an English UI text; {0}, {1}… are replaced by the arguments. */
function tx(text, ...args) {
  const out = CATALOG[text] ?? text;
  return args.length ? out.replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? "")) : out;
}
function setLang(lang) {
  try { localStorage.setItem(LANG_KEY, lang); } catch {}
  location.reload();
}

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
const fmtDate = (s) => (s ? new Date(s).toLocaleString(LANG) : "—");
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
    throw new ApiError(401, { error: { message: tx("Signed out") } });
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
  const dlg = h("dialog", { "aria-label": title }, h("div", { class: "top" }, h("h2", { text: title }), h("button", { class: "btn", type: "button", onclick: () => dlg.close(), text: tx("Close") })), content);
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
  const b = h("button", { class: "btn", type: "button", text: tx("Copy") });
  b.onclick = async () => {
    await navigator.clipboard.writeText(text);
    b.textContent = tx("Copied");
    setTimeout(() => (b.textContent = tx("Copy")), 1200);
  };
  return b;
}

// ------------------------------------------------------------------ login
let me = null;
const allowed = (perm) => !perm || (me?.permissions ?? []).includes(perm);

async function signedIn() {
  me = await api("GET", "/me");
  const first = Object.entries(VIEWS).find(([, v]) => allowed(v.perm));
  const current = location.hash.replace(/^#\//, "").split(/[/?]/)[0];
  if (!VIEWS[current] || !allowed(VIEWS[current].perm)) location.hash = `#/${first ? first[0] : "overview"}`;
  render();
}

/** Back from the identity provider: #/login?code=… or #/login?error=…; resolves to an error text, or undefined once signed in. */
async function finishSso() {
  const params = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const code = params.get("code");
  history.replaceState(null, "", "/admin/#/");
  if (!code) return params.get("error") ?? "";
  const res = await fetch("/auth/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
  const data = await res.json().catch(() => null);
  if (!res.ok) return data?.error?.message ?? tx("Sign-in failed");
  sessionStorage.setItem(KEY, data.token);
  await signedIn();
  return undefined;
}

function loginView(error) {
  const input = h("input", { type: "password", placeholder: "ea_admin_…", autocomplete: "off", "aria-label": tx("Admin key") });
  const msg = h("div", {}, error ? notice(error, true) : null);
  const sso = h("div");
  fetch("/auth/sso")
    .then((r) => r.json())
    .then((o) => {
      if (!o.enabled) return;
      const tenant = h("input", { placeholder: "ten_…", "aria-label": tx("Organization id") });
      sso.replaceChildren(
        h(
          "form",
          {
            onsubmit: (e) => {
              e.preventDefault();
              location.href = `/auth/oidc/start${o.tenantRequired ? `?tenant=${encodeURIComponent(tenant.value.trim())}` : ""}`;
            },
          },
          o.tenantRequired ? field(tx("Organization id"), tenant, tx("Ask your administrator.")) : null,
          h("button", { class: "btn primary", type: "submit", text: tx("Sign in with single sign-on") }),
        ),
        h("p", { class: "muted small", style: "text-align:center;margin:14px 0 4px", text: tx("or with an admin API key") }),
      );
    })
    .catch(() => {});
  const form = h(
    "form",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        sessionStorage.setItem(KEY, input.value.trim());
        try {
          await signedIn();
        } catch (err) {
          sessionStorage.removeItem(KEY);
          msg.replaceChildren(notice(errorText(err), true));
        }
      },
    },
    field(tx("Admin key"), input, tx("Printed by `pnpm seed`. Kept only in this browser tab.")),
    h("button", { class: "btn", type: "submit", text: tx("Sign in with key") }),
  );
  return h("div", { class: "login" }, h("div", { class: "card" }, h("h1", { text: "embed-assistant" }), h("p", { class: "muted", text: tx("Admin console") }), msg, sso, form), h("div", { class: "login-lang" }, langSelect()));
}

// ------------------------------------------------------------------ views
const VIEWS = {
  overview: { title: tx("Overview"), render: overview, perm: "analytics:read" },
  inbox: { title: tx("Inbox"), render: inbox, perm: "conversations:read" },
  insights: { title: tx("Insights"), render: insights, perm: "analytics:read" },
  assistants: { title: tx("Assistants"), render: assistants, perm: "config:read" },
  widgets: { title: tx("Widgets"), render: widgets, perm: "config:read" },
  knowledge: { title: tx("Knowledge"), render: knowledge, perm: "config:read" },
  actions: { title: tx("Actions"), render: actions, perm: "config:read" },
  playbooks: { title: tx("Playbooks"), render: playbooks, perm: "config:read" },
  mcp: { title: tx("MCP servers"), render: mcpServers, perm: "config:read" },
  conversations: { title: tx("Conversations"), render: conversations, perm: "conversations:read" },
  evals: { title: tx("Evaluations"), render: evals, perm: "config:read" },
  webhooks: { title: tx("Webhooks"), render: webhooks, perm: "config:read" },
  team: { title: tx("Team and sign-in"), render: team, perm: "security:manage" },
  audit: { title: tx("Audit log"), render: auditLog, perm: "security:manage" },
  settings: { title: tx("Settings"), render: settings, perm: "security:manage" },
};
let pollTimer = null;

async function overview(main) {
  const [usage, models] = await Promise.all([api("GET", "/usage?days=7"), api("GET", "/models")]);
  const setup = allowed("config:read") ? await setupCard(models).catch(() => null) : null;
  if (setup) main.append(setup);
  const stat = (k, v) => h("div", { class: "card stat" }, h("div", { class: "v", text: String(v) }), h("div", { class: "k", text: k }));
  const satisfaction = usage.feedbackUp + usage.feedbackDown ? `${Math.round((100 * usage.feedbackUp) / (usage.feedbackUp + usage.feedbackDown))}%` : "—";
  main.append(
    h("p", { class: "muted", text: tx("Last 7 days") }),
    h(
      "div",
      { class: "grid" },
      stat(tx("Answers"), usage.runs),
      stat(tx("Failed"), usage.failedRuns),
      stat(tx("Tokens in / out"), `${usage.inputTokens.toLocaleString()} / ${usage.outputTokens.toLocaleString()}`),
      stat(tx("Helpful ratings"), satisfaction),
      stat(tx("Time to first token (p50)"), usage.p50FirstTokenMs ? `${Math.round(usage.p50FirstTokenMs)} ms` : "—"),
      stat(tx("Time to first token (p95)"), usage.p95FirstTokenMs ? `${Math.round(usage.p95FirstTokenMs)} ms` : "—"),
    ),
    h(
      "div",
      { class: "card" },
      h("h2", { text: tx("Model aliases") }),
      h("p", { class: "muted small", text: tx("Assistants pick an alias. Deployments are tried in order; unavailable ones (no credentials) are skipped.") }),
      h(
        "table",
        {},
        h("thead", {}, h("tr", {}, h("th", { text: tx("Alias") }), h("th", { text: tx("Deployments (in failover order)") }))),
        h(
          "tbody",
          {},
          models.map((m) =>
            h(
              "tr",
              {},
              h("td", {}, h("code", { text: m.alias })),
              h("td", {}, m.deployments.map((d) => h("span", { class: `badge ${d.available ? "ok" : ""}`, title: d.available ? "available" : tx("not configured"), text: `${d.id} · ${d.model}${d.vision ? tx(" · sees images") : ""}` }), " ")),
            ),
          ),
        ),
      ),
    ),
  );
}

/** Getting started: what is still missing before visitors get good answers. Hidden once everything is done. */
async function setupCard(models) {
  const [sources, assistantsList, widgetsList, usage30] = await Promise.all([api("GET", "/sources"), api("GET", "/assistants"), api("GET", "/widgets"), api("GET", "/usage?days=30")]);
  const realModel = models.some((m) => m.deployments.some((d) => d.available && d.model !== "extractive"));
  const docs = sources.reduce((n, x) => n + (x.documentCount ?? 0), 0);
  const local = (o) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(o) || o === "*";
  const liveWidget = widgetsList.some((w) => (w.allowedOrigins ?? []).some((o) => !local(o)));
  const steps = [
    [realModel, tx("Connect an AI model"), tx("Set ANTHROPIC_API_KEY, OPENAI_API_KEY (or any OpenAI-compatible server) in the server environment. Until then answers are quotes from your knowledge, not written answers."), null],
    [docs > 0, tx("Add your knowledge"), tx("A website (start page), a sitemap, files or documents pushed through the API."), "knowledge"],
    [assistantsList.length > 0, tx("Set up an assistant"), tx("Greeting, suggested questions, tone and where to hand off when it cannot help."), "assistants"],
    [liveWidget, tx("Allow your website"), tx("Add your site's address (for example https://www.example.com) to a widget's allowed websites, then paste its embed code."), "widgets"],
    [usage30.runs > 0, tx("Get the first questions"), tx("Open your site and ask something, or use Try on the widget."), "widgets"],
  ];
  if (steps.every(([done]) => done)) return null;
  return h(
    "div",
    { class: "card" },
    h("h2", { text: tx("Getting started · {0} of {1} done", steps.filter(([d]) => d).length, steps.length) }),
    h(
      "ol",
      { class: "steps" },
      steps.map(([done, title, hint, view]) =>
        h(
          "li",
          { class: done ? "done" : "" },
          h("span", { class: `badge ${done ? "ok" : "warn"}`, text: done ? tx("done") : tx("to do") }),
          " ",
          view && !done ? h("a", { href: `#/${view}`, text: title }) : h("strong", { text: title }),
          done ? null : h("div", { class: "muted small", text: hint }),
        ),
      ),
    ),
  );
}

async function assistants(main) {
  const [list, sources, models, actionList, mcpList, playbookList] = await Promise.all([
    api("GET", "/assistants"),
    api("GET", "/sources"),
    api("GET", "/models"),
    api("GET", "/actions"),
    api("GET", "/mcp-servers"),
    api("GET", "/playbooks").then((r) => r.items),
  ]);
  const edit = (a) => assistantForm(a, sources, models, actionList, mcpList, () => route(), playbookList);
  main.append(
    h("div", { class: "row", style: "margin-bottom:12px" }, h("button", { class: "btn primary", onclick: () => edit(null), text: tx("New assistant") })),
    h(
      "div",
      { class: "card" },
      list.length
        ? h(
            "table",
            {},
            h("thead", {}, h("tr", {}, [tx("Name"), tx("Model"), tx("Knowledge"), tx("Mode"), tx("Updated"), ""].map((t) => h("th", { text: t })))),
            h(
              "tbody",
              {},
              list.map((a) =>
                h(
                  "tr",
                  {},
                  h("td", {}, h("strong", { text: a.name }), h("div", { class: "muted small mono", text: `${a.id} · v${a.version}` })),
                  h("td", {}, h("code", { text: a.modelAlias })),
                  h("td", { text: a.sourceIds.map((id) => sources.find((s) => s.id === id)?.name ?? id).join(", ") || "—" }),
                  h("td", { text: a.groundedOnly ? tx("Sources only") : tx("Sources + general") }),
                  h("td", { class: "small", text: fmtDate(a.updatedAt) }),
                  h(
                    "td",
                    { class: "row" },
                    h("button", { class: "btn", onclick: () => edit(a), text: tx("Edit") }),
                    h("button", { class: "btn", onclick: () => versionHistory(a, { sources, actionList, mcpList, playbookList }), text: tx("History") }),
                    h("button", {
                      class: "btn danger",
                      text: tx("Delete"),
                      onclick: async () => {
                        if (!confirm(tx("Delete assistant \"{0}\" and its widgets?", a.name))) return;
                        await api("DELETE", `/assistants/${a.id}`);
                        route();
                      },
                    }),
                  ),
                ),
              ),
            ),
          )
        : h("p", { class: "muted", text: tx("No assistants yet.") }),
    ),
  );
}

function assistantForm(a, sources, models, actionList, mcpList, done, playbookList = []) {
  const f = {
    name: h("input", { value: a?.name ?? "", required: true, maxlength: 100 }),
    instructions: h("textarea", { value: a?.instructions ?? "", rows: 6, placeholder: tx("Tone, scope, what to do when unsure…") }),
    modelAlias: h("select", {}, models.map((m) => h("option", { value: m.alias, text: m.alias }))),
    greeting: h("input", { value: a?.greeting ?? tx("Hi! How can I help you today?") }),
    suggestions: h("textarea", { value: (a?.suggestions ?? []).join("\n"), rows: 3 }),
    placeholder: h("input", { value: a?.placeholder ?? "" }),
    disclaimer: h("input", { value: a?.disclaimer ?? "" }),
    groundedOnly: h("input", { type: "checkbox", checked: a ? a.groundedOnly : true }),
    followUps: h("input", { type: "checkbox", checked: a ? a.followUps : true }),
    queryRewrite: h("input", { type: "checkbox", checked: a ? a.queryRewrite : true }),
    agenticSearch: h("input", { type: "checkbox", checked: a ? a.agenticSearch : true }),
    clientTools: h("input", { type: "checkbox", checked: a ? a.clientTools : true }),
    redactPii: h("input", { type: "checkbox", checked: a ? a.redactPii : false }),
    memory: h("input", { type: "checkbox", checked: a ? a.memory : false }),
    handoffEnabled: h("input", { type: "checkbox", checked: a?.handoff?.enabled ?? false }),
    handoffMessage: h("input", { value: a?.handoff?.message ?? tx("I've passed this conversation to our team. Someone will get back to you as soon as possible.") }),
    handoffUrl: h("input", { value: a?.handoff?.url ?? "", placeholder: "https://example.com/contact (optional)" }),
    handoffLabel: h("input", { value: a?.handoff?.label ?? "", placeholder: tx("Talk to a person") }),
    blockedTerms: h("textarea", { value: (a?.guardrails?.blockedTerms ?? []).join("\n"), rows: 3, placeholder: tx("One word or phrase per line") }),
    blockedTopics: h("textarea", { value: (a?.guardrails?.blockedTopics ?? []).join("\n"), rows: 3, placeholder: tx("e.g. medical diagnosis\ncompetitor products") }),
    moderation: h("input", { type: "checkbox", checked: a?.guardrails?.moderation ?? false }),
    promptInjection: h("input", { type: "checkbox", checked: a?.guardrails?.promptInjection ?? false }),
    checkAnswers: h("input", { type: "checkbox", checked: a?.guardrails?.checkAnswers ?? true }),
    refusalMessage: h("input", { value: a?.guardrails?.refusalMessage ?? tx("Sorry, I can't help with that. Is there something else I can help you with?"), maxlength: 1000 }),
    changeNote: h("input", { maxlength: 500, placeholder: tx("What changed and why (optional)") }),
    tone: h("select", {}, [["neutral", tx("Neutral")], ["friendly", tx("Friendly")], ["formal", tx("Formal")]].map(([v, t]) => h("option", { value: v, text: t }))),
    length: h("select", {}, [["short", tx("Short")], ["medium", tx("Medium")], ["detailed", tx("Detailed")]].map(([v, t]) => h("option", { value: v, text: t }))),
  };
  f.tone.value = a?.style?.tone ?? "neutral";
  f.length.value = a?.style?.length ?? "medium";
  const playbookChecks = playbookList.map((x) => {
    const c = h("input", { type: "checkbox", value: x.id, checked: a?.playbookIds?.includes(x.id) });
    return h("label", { class: "check" }, c, `${x.title} `, h("code", { text: x.name }), x.enabled ? null : h("span", { class: "badge", text: tx("disabled") }));
  });
  const actionChecks = actionList.map((x) => {
    const c = h("input", { type: "checkbox", value: x.id, checked: a?.actionIds?.includes(x.id) });
    return h("label", { class: "check" }, c, `${x.title} `, h("code", { text: x.name }), x.confirm ? h("span", { class: "badge warn", text: tx("asks first") }) : null, x.enabled ? null : h("span", { class: "badge", text: tx("disabled") }));
  });
  const mcpChecks = mcpList.map((x) => {
    const c = h("input", { type: "checkbox", value: x.id, checked: a?.mcpServerIds?.includes(x.id) });
    return h("label", { class: "check" }, c, `${x.title} `, h("span", { class: "muted small", text: tx("{0} tools", x.tools.length) }), x.lastError ? h("span", { class: "badge bad", text: tx("error") }) : null, x.enabled ? null : h("span", { class: "badge", text: tx("disabled") }));
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
          memory: f.memory.checked,
          playbookIds: playbookChecks.map((l) => l.querySelector("input")).filter((c) => c.checked).map((c) => c.value),
          style: { tone: f.tone.value, length: f.length.value },
          handoff: {
            enabled: f.handoffEnabled.checked,
            message: f.handoffMessage.value.trim() || tx("I've passed this conversation to our team."),
            url: f.handoffUrl.value.trim() || null,
            label: f.handoffLabel.value.trim() || null,
          },
          guardrails: {
            blockedTerms: lines(f.blockedTerms.value),
            blockedTopics: lines(f.blockedTopics.value),
            moderation: f.moderation.checked,
            promptInjection: f.promptInjection.checked,
            checkAnswers: f.checkAnswers.checked,
            refusalMessage: f.refusalMessage.value.trim() || undefined,
            ...(a?.guardrails?.supportMessage ? { supportMessage: a.guardrails.supportMessage } : {}),
          },
          ...(f.changeNote.value.trim() ? { changeNote: f.changeNote.value.trim() } : {}),
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
    field(tx("Name"), f.name),
    field(tx("Instructions"), f.instructions, tx("Added to the system prompt. Safety and citation rules are always applied.")),
    h("div", { class: "two" }, field(tx("Model alias"), f.modelAlias), field(tx("Greeting"), f.greeting)),
    field(tx("Suggested questions"), f.suggestions, tx("One per line, up to 6.")),
    h("div", { class: "two" }, field(tx("Input placeholder"), f.placeholder), field(tx("Disclaimer"), f.disclaimer)),
    h("fieldset", { class: "box" }, h("legend", { text: tx("Knowledge sources") }), sourceChecks.length ? sourceChecks : h("span", { class: "muted", text: tx("No sources yet.") })),
    h("label", { class: "check" }, f.groundedOnly, tx("Answer only from knowledge sources (recommended for support)")),
    h("fieldset", { class: "box" }, h("legend", { text: tx("Actions (tools)") }), actionChecks.length ? actionChecks : h("span", { class: "muted", text: tx("No actions yet. Create them under Actions.") })),
    h("fieldset", { class: "box" }, h("legend", { text: tx("MCP servers") }), mcpChecks.length ? mcpChecks : h("span", { class: "muted", text: tx("None connected. Add them under MCP servers.") })),
    h("fieldset", { class: "box" }, h("legend", { text: tx("Playbooks") }), playbookChecks.length ? playbookChecks : h("span", { class: "muted", text: tx("No playbooks yet. Write them under Playbooks.") })),
    h("div", { class: "two" }, field(tx("Tone"), f.tone), field(tx("Answer length"), f.length)),
    h(
      "fieldset",
      { class: "box" },
      h("legend", { text: tx("Human handoff") }),
      h("label", { class: "check" }, f.handoffEnabled, tx("Offer “talk to a person” (delivered through the handoff.requested webhook)")),
      field(tx("Message shown to the visitor"), f.handoffMessage),
      h("div", { class: "two" }, field(tx("Contact link"), f.handoffUrl), field(tx("Button label"), f.handoffLabel)),
    ),
    h(
      "fieldset",
      { class: "box" },
      h("legend", { text: tx("Guardrails") }),
      h("div", { class: "two" }, field(tx("Blocked terms"), f.blockedTerms, tx("Questions containing one are refused without calling the model.")), field(tx("Blocked topics"), f.blockedTopics, tx("Checked by a classifier on the fast model."))),
      h("label", { class: "check" }, f.moderation, tx("Refuse harmful requests (violence, weapons, self-harm, sexual content, hate, illegal activity)")),
      h("label", { class: "check" }, f.promptInjection, tx("Refuse attempts to override the instructions or reveal the prompt")),
      h("label", { class: "check" }, f.checkAnswers, tx("Replace answers that contain a blocked term")),
      field(tx("Refusal message"), f.refusalMessage),
    ),
    h(
      "fieldset",
      { class: "box" },
      h("legend", { text: tx("Behaviour") }),
      h("label", { class: "check" }, f.followUps, tx("Suggest follow-up questions after answers")),
      h("label", { class: "check" }, f.queryRewrite, tx("Understand follow-up questions in context (query rewriting)")),
      h("label", { class: "check" }, f.agenticSearch, tx("Let the model run extra knowledge searches")),
      h("label", { class: "check" }, f.clientTools, tx("Accept tools registered by the host page")),
      h("label", { class: "check" }, f.redactPii, tx("Mask e-mails, phone numbers, card numbers and IBANs")),
      h("label", { class: "check" }, f.memory, tx("Remember signed-in users across conversations (they can see and erase it in the widget)")),
    ),
    field(tx("Change note"), f.changeNote, tx("Kept in the version history. Every save is a new version you can compare, evaluate and restore.")),
    msg,
    h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit", text: a ? tx("Save") : tx("Create") })),
  );
  const dlg = modal(a ? tx("Edit {0}", a.name) : tx("New assistant"), form);
}

const CONFIG_LABELS = {
  name: "Name", instructions: tx("Instructions"), modelAlias: tx("Model alias"), greeting: tx("Greeting"), suggestions: tx("Suggested questions"),
  placeholder: tx("Input placeholder"), disclaimer: tx("Disclaimer"), sourceIds: tx("Knowledge sources"), groundedOnly: tx("Sources only"),
  actionIds: tx("Actions"), mcpServerIds: tx("MCP servers"), handoff: tx("Human handoff"), followUps: tx("Follow-up suggestions"),
  queryRewrite: tx("Query rewriting"), agenticSearch: tx("Extra searches"), clientTools: tx("Page tools"), redactPii: tx("Mask personal data"), guardrails: tx("Guardrails"),
  memory: tx("Memory"), playbookIds: tx("Playbooks"), style: "Tone and length",
};

/** A config value as readable text: ids become names, objects become indented JSON. */
function configText(key, value, refs) {
  const named = { sourceIds: refs.sources, actionIds: refs.actionList, mcpServerIds: refs.mcpList, playbookIds: refs.playbookList ?? [] }[key];
  if (named) return value.length ? value.map((id) => { const x = named.find((n) => n.id === id); return x ? x.title ?? x.name : tx("{0} (deleted)", id); }).join("\n") : "—";
  if (value === null || value === "") return "—";
  if (typeof value === "boolean") return value ? "on" : "off";
  if (Array.isArray(value)) return value.length ? value.join("\n") : "—";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

async function versionHistory(a, refs) {
  const body = h("div", {}, h("p", { class: "muted", text: tx("Loading…") }));
  const dlg = modal(tx("History of {0}", a.name), body, { wide: true });
  const canWrite = allowed("config:write");
  const list = await api("GET", `/assistants/${a.id}/versions`);
  const current = list.items[0]?.version;
  body.replaceChildren(
    h("p", { class: "muted small", text: tx("Every save is kept. Compare any version with the live one, evaluate it on a suite (Evaluations → Run → Version), or restore it as a new version.") }),
    h(
      "table",
      {},
      h("thead", {}, h("tr", {}, [tx("Version"), tx("Saved"), tx("Changed"), ""].map((t) => h("th", { text: t })))),
      h(
        "tbody",
        {},
        list.items.map((v) =>
          h(
            "tr",
            {},
            h("td", {}, h("strong", { text: `v${v.version}` }), v.version === current ? h("span", { class: "badge ok", text: " live" }) : null),
            h("td", { class: "small" }, fmtDate(v.createdAt), h("div", { class: "muted", text: v.createdBy ?? "" })),
            h(
              "td",
              { class: "small" },
              v.note ? h("div", { text: v.note }) : null,
              h("div", { class: "row", style: "gap:4px;flex-wrap:wrap" }, v.changes.length ? v.changes.map((c) => h("span", { class: "badge", text: CONFIG_LABELS[c] ?? c })) : h("span", { class: "muted", text: v.version === list.items.at(-1)?.version ? tx("first recorded version") : tx("no field changed") })),
            ),
            h(
              "td",
              { class: "row" },
              v.version === current ? null : h("button", { class: "btn", text: tx("Compare"), onclick: () => compareVersion(a, v.version, current, refs) }),
              v.version === current || !canWrite
                ? null
                : h("button", {
                    class: "btn",
                    text: tx("Restore"),
                    onclick: async () => {
                      if (!confirm(tx("Restore v{0} of \"{1}\"? It is saved as a new version and goes live immediately.", v.version, a.name))) return;
                      try {
                        await api("POST", `/assistants/${a.id}/versions/${v.version}/restore`, {});
                        dlg.close();
                        route();
                      } catch (err) {
                        alert(errorText(err));
                      }
                    },
                  }),
            ),
          ),
        ),
      ),
    ),
  );
}

async function compareVersion(a, version, current, refs) {
  const [old, live] = await Promise.all([api("GET", `/assistants/${a.id}/versions/${version}`), api("GET", `/assistants/${a.id}/versions/${current}`)]);
  const keys = Object.keys(CONFIG_LABELS).filter((k) => JSON.stringify(old.config[k]) !== JSON.stringify(live.config[k]));
  const cell = (k, v) => h("td", {}, h("pre", { class: "small", style: "white-space:pre-wrap;margin:0;max-height:240px;overflow:auto", text: configText(k, v, refs) }));
  modal(
    tx("v{0} compared with live v{1}", version, current),
    keys.length
      ? h(
          "table",
          {},
          h("thead", {}, h("tr", {}, [tx("Field"), `v${version}`, tx("v{0} (live)", current)].map((t) => h("th", { text: t })))),
          h("tbody", {}, keys.map((k) => h("tr", {}, h("td", { text: CONFIG_LABELS[k] }), cell(k, old.config[k]), cell(k, live.config[k])))),
        )
      : h("p", { class: "muted", text: tx("Same configuration as the live version.") }),
    { wide: true },
  );
}

async function widgets(main) {
  const [list, assistantsList] = await Promise.all([api("GET", "/widgets"), api("GET", "/assistants")]);
  const edit = (w) => widgetForm(w, assistantsList, () => route());
  main.append(
    h("div", { class: "row", style: "margin-bottom:12px" }, h("button", { class: "btn primary", disabled: !assistantsList.length, onclick: () => edit(null), text: tx("New widget") })),
    h(
      "div",
      { class: "card" },
      list.length
        ? h(
            "table",
            {},
            h("thead", {}, h("tr", {}, [tx("Name"), tx("Assistant"), tx("Allowed websites"), ""].map((t) => h("th", { text: t })))),
            h(
              "tbody",
              {},
              list.map((w) =>
                h(
                  "tr",
                  {},
                  h("td", {}, h("strong", { text: w.name }), h("div", { class: "muted small mono", text: w.id })),
                  h("td", { text: assistantsList.find((a) => a.id === w.assistantId)?.name ?? w.assistantId }),
                  h("td", { class: "small" }, w.allowedOrigins.length ? w.allowedOrigins.join(", ") : h("span", { class: "badge bad", text: tx("none (blocked everywhere)") })),
                  h(
                    "td",
                    { class: "row" },
                    h("button", { class: "btn", onclick: () => showSnippet(w), text: tx("Embed") }),
                    h("a", { class: "btn", href: `/demo?widget=${encodeURIComponent(w.id)}`, target: "_blank", rel: "noopener", text: tx("Try") }),
                    h("button", { class: "btn", onclick: () => edit(w), text: tx("Edit") }),
                    h("button", {
                      class: "btn",
                      text: tx("Rotate secret"),
                      onclick: async () => {
                        if (!confirm(tx("Rotate the identity secret? User tokens signed with the old secret stop working immediately."))) return;
                        const r = await api("POST", `/widgets/${w.id}/rotate-secret`);
                        modal(tx("New identity secret"), secretBox(r.identitySecret));
                      },
                    }),
                    h("button", {
                      class: "btn danger",
                      text: tx("Delete"),
                      onclick: async () => {
                        if (!confirm(tx("Delete widget \"{0}\"? Its conversations are deleted too.", w.name))) return;
                        await api("DELETE", `/widgets/${w.id}`);
                        route();
                      },
                    }),
                  ),
                ),
              ),
            ),
          )
        : h("p", { class: "muted", text: assistantsList.length ? tx("No widgets yet.") : tx("Create an assistant first.") }),
    ),
  );
}

function secretBox(secret) {
  return h(
    "div",
    { class: "secret" },
    h("strong", { text: tx("Identity secret (shown once)") }),
    h("p", { class: "small muted", text: tx("Store it in your backend only. It signs the user tokens that tell the assistant who is signed in. Never put it in browser code.") }),
    h("pre", { text: secret }),
    copyButton(secret),
  );
}

async function showSnippet(w) {
  const { html } = await api("GET", `/widgets/${w.id}/snippet`);
  modal(
    tx("Embed {0}", w.name),
    h(
      "div",
      {},
      h("p", { text: "Paste before </body> on any page of an allowed website:" }),
      h("pre", { text: html }),
      copyButton(html),
      h("p", { class: "small muted", text: tx("Optional attributes: data-locale, data-position, data-accent-color, data-mode, data-open, data-launcher=\"false\". JavaScript API: window.EmbedAssistant (open, close, toggle, ask, setContext, identify, on).") }),
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
    locale: h("input", { value: w?.defaultLocale ?? "", placeholder: tx("auto (visitor's browser)") }),
    budget: h("input", { type: "number", min: 1, value: w?.dailyTokenBudget ?? "", placeholder: tx("server default") }),
    feedback: h("input", { type: "checkbox", checked: w ? w.features.feedback : true }),
    sources: h("input", { type: "checkbox", checked: w ? w.features.sources : true }),
    history: h("input", { type: "checkbox", checked: w ? w.features.history : true }),
    voice: h("input", { type: "checkbox", checked: w ? w.features.voice : false }),
    attachments: h("input", { type: "checkbox", checked: w ? w.features.attachments : false }),
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
          features: { feedback: f.feedback.checked, sources: f.sources.checked, history: f.history.checked, voice: f.voice.checked, attachments: f.attachments.checked },
        };
        try {
          const r = await api(w ? "PATCH" : "POST", w ? `/widgets/${w.id}` : "/widgets", body);
          dlg.close();
          done();
          if (!w) modal(tx("Widget created"), h("div", {}, h("p", { text: tx("Embed snippet:") }), h("pre", { text: r.embedSnippet }), copyButton(r.embedSnippet), secretBox(r.identitySecret)));
        } catch (err) {
          msg.replaceChildren(notice(errorText(err), true));
        }
      },
    },
    h("div", { class: "two" }, field(tx("Name"), f.name), field(tx("Assistant"), f.assistantId)),
    field(tx("Allowed websites"), f.origins, tx("One origin per line, e.g. https://www.example.com. Use * only for testing.")),
    h("div", { class: "two" }, field(tx("Accent color"), f.accent), field(tx("Theme"), f.mode)),
    h("div", { class: "two" }, field(tx("Position"), f.position), field(tx("Corner radius"), f.radius)),
    h("div", { class: "two" }, field(tx("Default UI language"), f.locale), field(tx("Daily token budget"), f.budget)),
    h("div", { class: "row" }, h("label", { class: "check" }, f.feedback, tx("Feedback buttons")), h("label", { class: "check" }, f.sources, tx("Show sources")), h("label", { class: "check" }, f.history, tx("Conversation history")), h("label", { class: "check" }, f.voice, tx("Voice input")), h("label", { class: "check", title: tx("Visitors can attach screenshots. Needs a model that can see images (see Models).") }, f.attachments, tx("Image attachments"))),
    h("p", { class: "muted small", style: "margin-top:4px", text: tx("Voice input uses the browser's speech recognition; Chrome and Edge send the audio to their vendor's speech service, Safari may process it on the device.") }),
    msg,
    h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit", text: w ? tx("Save") : tx("Create") })),
  );
  const dlg = modal(w ? tx("Edit {0}", w.name) : tx("New widget"), form);
}

async function knowledge(main) {
  const list = await api("GET", "/sources");
  const badge = (s) => h("span", { class: `badge ${s === "succeeded" ? "ok" : s === "failed" ? "bad" : s === "idle" ? "" : "warn"}`, text: s });
  main.append(
    h("div", { class: "row", style: "margin-bottom:12px" }, h("button", { class: "btn primary", onclick: () => sourceForm(() => route()), text: tx("Add knowledge") })),
    h(
      "div",
      { class: "card" },
      list.length
        ? h(
            "table",
            {},
            h("thead", {}, h("tr", {}, [tx("Source"), tx("Access"), tx("Status"), tx("Documents"), tx("Last update"), ""].map((t) => h("th", { text: t })))),
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
                    s.syncIntervalHours ? h("div", { class: "muted small", text: tx("Re-syncs every {0} h", s.syncIntervalHours) }) : null,
                  ),
                  h("td", {}, s.access.map((a) => h("span", { class: "badge", text: a }))),
                  h("td", {}, badge(s.status), s.lastError ? h("div", { class: "small muted", text: s.lastError }) : null),
                  h("td", { text: String(s.documentCount) }),
                  h("td", { class: "small", text: fmtDate(s.lastIngestedAt) }),
                  h(
                    "td",
                    { class: "row" },
                    h("button", { class: "btn", onclick: () => documentsDialog(s), text: tx("Documents") }),
                    s.type === "manual" ? h("button", { class: "btn", onclick: () => uploadDialog(s), text: tx("Upload files") }) : null,
                    h("button", { class: "btn", onclick: () => sourceEdit(s), text: tx("Edit") }),
                    s.type !== "manual"
                      ? h("button", {
                          class: "btn",
                          text: tx("Sync"),
                          disabled: s.status === "queued" || s.status === "running",
                          onclick: async () => {
                            await api("POST", `/sources/${s.id}/sync`);
                            route();
                          },
                        })
                      : null,
                    h("button", {
                      class: "btn danger",
                      text: tx("Delete"),
                      onclick: async () => {
                        if (!confirm(tx("Delete \"{0}\" and all its documents?", s.name))) return;
                        await api("DELETE", `/sources/${s.id}`);
                        route();
                      },
                    }),
                  ),
                ),
              ),
            ),
          )
        : h("p", { class: "muted", text: tx("No knowledge yet. Add a website, a sitemap, or push documents through the API.") }),
    ),
    list.length ? await searchTester() : null,
  );
  if (list.some((s) => s.status === "queued" || s.status === "running")) pollTimer = setTimeout(() => route(), 3000);
}

/** Question topics: the latest analysis, and a button to run one for the selected period. */
async function topicsCard(days) {
  const card = h("div", { class: "card", style: "margin-bottom:16px" });
  const draw = async () => {
    const { items } = await api("GET", "/insights/topics").catch(() => ({ items: [] }));
    const latest = items[0];
    const busy = latest && (latest.status === "queued" || latest.status === "running");
    const start = h("button", {
      class: "btn primary",
      type: "button",
      disabled: busy,
      text: busy ? tx("Analysing…") : tx("Analyse the last {0} days", days),
      onclick: async () => {
        try {
          await api("POST", "/insights/topics", { days });
          draw();
        } catch (err) {
          alert(errorText(err));
        }
      },
    });
    const done = items.find((r) => r.status === "completed");
    card.replaceChildren(
      h("div", { class: "top" }, h("h2", { text: tx("Topics") }), start),
      h("p", { class: "muted small", text: tx("Visitor questions grouped by what people need, with how each group went. Groups that go badly come first, with the article to write or fix.") }),
      done ? topicsTable(done) : h("p", { class: "muted", text: busy ? tx("The first analysis is running…") : tx("No analysis yet.") }),
      ...(latest?.status === "failed" ? [h("p", { class: "notice error", text: tx("Last analysis failed: {0}", latest.error ?? tx("unknown error")) })] : []),
    );
    if (busy) setTimeout(() => card.isConnected && draw(), 3000);
  };
  await draw();
  return card;
}

function topicsTable(r) {
  const pctOf = (x) => `${Math.round(x * 100)}%`;
  return h(
    "div",
    {},
    h("p", { class: "small muted", text: tx("{0} – {1} · {2} distinct questions · grouped {3}{4}", fmtDate(r.from), fmtDate(r.to), r.questionCount, r.method === "model" ? tx("by the AI model") : tx("by shared words"), r.trigger === "schedule" ? tx(" · weekly digest") : "") }),
    r.topics.length
      ? h(
          "table",
          {},
          h("thead", {}, h("tr", {}, [tx("Topic"), tx("Questions"), tx("Problems"), tx("Suggested article")].map((t) => h("th", { text: t })))),
          h(
            "tbody",
            {},
            r.topics.map((t) =>
              h(
                "tr",
                {},
                h(
                  "td",
                  {},
                  h("strong", { text: t.name }),
                  h("div", { class: "small muted", text: t.examples.slice(0, 3).map((e) => `“${e}”`).join(" · ") }),
                  t.relatedDocuments.length ? h("div", { class: "small", text: tx("Closest docs: {0}", t.relatedDocuments.map((d) => d.title).join(", ")) }) : null,
                ),
                h("td", { text: String(t.questions) }),
                h(
                  "td",
                  {},
                  h("span", { class: `badge ${t.problemRate >= 0.5 ? "bad" : t.problemRate > 0 ? "warn" : "ok"}`, text: pctOf(t.problemRate) }),
                  h("div", { class: "small muted", text: [t.unanswered && tx("{0} no knowledge", t.unanswered), t.downvoted && tx("{0} rated down", t.downvoted), t.handoffs && tx("{0} to a person", t.handoffs)].filter(Boolean).join(", ") }),
                ),
                h(
                  "td",
                  {},
                  t.suggestion
                    ? h(
                        "div",
                        {},
                        h("strong", { text: `${t.suggestion.action === "update" ? tx("Update") : tx("Write")}: ${t.suggestion.title}` }),
                        t.suggestion.outline.length ? h("ul", { class: "small" }, ...t.suggestion.outline.map((o) => h("li", { text: o }))) : null,
                      )
                    : h("span", { class: "muted small", text: "—" }),
                ),
              ),
            ),
          ),
        )
      : h("p", { class: "muted", text: tx("No questions in this period.") }),
  );
}

/** Try a query against an assistant's knowledge, as a visitor with some access groups would search it. */
async function searchTester() {
  const assistants = await api("GET", "/assistants").catch(() => []);
  if (!assistants.length) return null;
  const pick = h("select", { "aria-label": tx("Assistant") }, ...assistants.map((a) => h("option", { value: a.id, text: a.name })));
  const q = h("input", { type: "search", placeholder: tx("A question visitors ask"), "aria-label": tx("Query"), style: "flex:1;min-width:220px" });
  const groups = h("input", { placeholder: tx("Access groups, comma-separated (optional)"), "aria-label": tx("Access groups"), style: "min-width:220px" });
  const out = h("div", { style: "margin-top:12px" });
  const run = async (e) => {
    e?.preventDefault();
    if (!q.value.trim()) return;
    out.replaceChildren(h("p", { class: "muted", text: tx("Searching…") }));
    try {
      const params = new URLSearchParams({ q: q.value.trim(), ...(groups.value.trim() ? { access: groups.value.trim() } : {}) });
      const r = await api("GET", `/assistants/${pick.value}/search?${params}`);
      out.replaceChildren(
        r.results.length
          ? h(
              "ol",
              { class: "results" },
              ...r.results.map((x) =>
                h(
                  "li",
                  {},
                  /^https?:\/\//i.test(x.url ?? "") ? h("a", { href: x.url, target: "_blank", rel: "noopener noreferrer", text: x.title }) : h("strong", { text: x.title }),
                  h("div", { class: "small muted", text: x.snippet }),
                ),
              ),
            )
          : h("p", { class: "muted", text: tx("Nothing found. Visitors asking this get no grounded answer: add or fix a document.") }),
      );
    } catch (err) {
      out.replaceChildren(h("p", { class: "notice error", text: errorText(err) }));
    }
  };
  return h(
    "div",
    { class: "card", style: "margin-top:16px" },
    h("h2", { text: tx("Test search") }),
    h("p", { class: "muted small", text: tx("The passages an assistant would read for a question (public knowledge plus the access groups you enter). Also available to your site as POST /v1/search.") }),
    h("form", { class: "row", onsubmit: run }, pick, q, groups, h("button", { class: "btn primary", type: "submit", text: tx("Search") })),
    out,
  );
}

function sourceForm(done) {
  const f = {
    name: h("input", { required: true, placeholder: tx("Help center") }),
    type: h("select", {}, h("option", { value: "website", text: tx("Website (follow links)") }), h("option", { value: "sitemap", text: tx("Sitemap or llms.txt") }), h("option", { value: "url", text: tx("Single page") }), h("option", { value: "manual", text: tx("Manual / API push") })),
    url: h("input", { type: "url", placeholder: "https://example.com/help/" }),
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
    h("div", { class: "two" }, field(tx("Name"), f.name), field(tx("Type"), f.type)),
    field(tx("URL"), f.url, tx("Website: the start page; links are followed on the same site under its folder, respecting robots.txt. Sitemap: a sitemap.xml or llms.txt. Ignored for manual sources (upload files or push documents through the API).")),
    h("div", { class: "two" }, field(tx("Access tags"), f.access, tx("public = everyone; users = any signed-in user; other tags = users whose token lists them in groups.")), field(tx("Max pages"), f.maxPages)),
    field(tx("Keep in sync"), f.sync, tx("Crawled sources only.")),
    msg,
    h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit", text: tx("Add") })),
  );
  const dlg = modal(tx("Add knowledge"), form);
}

const SYNC_OPTIONS = [[0, tx("Only when I click Sync")], [6, tx("Every 6 hours")], [24, tx("Daily")], [168, tx("Weekly")]];
function syncSelect(current) {
  const opts = SYNC_OPTIONS.some(([v]) => v === (current ?? 0)) ? SYNC_OPTIONS : [...SYNC_OPTIONS, [current, tx("Every {0} hours", current)]];
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
    field(tx("Name"), f.name),
    crawled ? field(tx("URL"), f.url) : null,
    field(tx("Access tags"), f.access, tx("Changing tags applies to all stored documents immediately.")),
    crawled ? h("div", { class: "two" }, field(tx("Max pages"), f.maxPages), field(tx("Keep in sync"), f.sync)) : null,
    msg,
    h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit", text: tx("Save") })),
  );
  const dlg = modal(tx("Edit {0}", s.name), form);
}

function uploadDialog(s) {
  const input = h("input", { type: "file", multiple: true, accept: ".pdf,.docx,.md,.markdown,.txt,.html,.htm,.csv,.json" });
  const out = h("div");
  const btn = h("button", { class: "btn primary", type: "submit", text: tx("Upload") });
  const form = h(
    "form",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        if (!input.files.length) return;
        const fd = new FormData();
        for (const file of input.files) fd.append("file", file);
        btn.disabled = true;
        out.replaceChildren(h("p", { class: "muted", text: tx("Reading {0} file(s)…", input.files.length) }));
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
    field(tx("Files"), input, tx("PDF, Word (.docx), Markdown, HTML or text, up to 20 MB each. A file with the same name replaces the earlier version. Scanned PDFs need OCR first.")),
    h("div", { class: "row" }, btn),
    out,
  );
  const dlg = modal(tx("Upload to {0}", s.name), form, { wide: true });
  dlg.addEventListener("close", () => route());
}

async function documentsDialog(s) {
  const body = h("div", {}, h("p", { class: "muted", text: tx("Loading…") }));
  modal(tx("{0} · documents", s.name), body, { wide: true });
  const load = async () => {
    const docs = await api("GET", `/sources/${s.id}/documents?limit=500`);
    const f = {
      title: h("input", { required: true }),
      url: h("input", { type: "url", placeholder: tx("optional") }),
      content: h("textarea", { required: true, rows: 8, placeholder: tx("Markdown or plain text") }),
    };
    const msg = h("div");
    body.replaceChildren(
      docs.length
        ? h(
            "table",
            {},
            h("thead", {}, h("tr", {}, [tx("Title"), tx("Chunks"), tx("Updated"), ""].map((t) => h("th", { text: t })))),
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
                    text: tx("Delete"),
                    onclick: async () => {
                      await api("DELETE", `/sources/${s.id}/documents/${d.id}`);
                      load();
                    },
                  })),
                ),
              ),
            ),
          )
        : h("p", { class: "muted", text: tx("No documents.") }),
      h("h2", { style: "margin-top:20px", text: tx("Add or replace a document") }),
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
        h("div", { class: "two" }, field(tx("Title"), f.title), field(tx("URL"), f.url)),
        field(tx("Content"), f.content),
        msg,
        h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit", text: tx("Save document") })),
      ),
    );
  };
  load().catch((err) => body.replaceChildren(notice(errorText(err), true)));
}

async function conversations(main) {
  const table = h("tbody");
  const more = h("button", { class: "btn", text: tx("Load more"), hidden: true });
  let cursor = null;
  const load = async () => {
    const page = await api("GET", `/conversations?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    for (const c of page.items) {
      table.append(
        h(
          "tr",
          {},
          h("td", {}, h("button", { class: "btn", onclick: () => transcript(c), text: c.title || tx("(untitled)") }), c.handoffRequestedAt ? h("span", { class: "badge warn", text: " handoff" }) : null),
          h("td", {}, h("span", { class: "badge", text: c.subjectKind }), " ", h("span", { class: "small mono muted", text: c.subjectId.slice(0, 40) })),
          h("td", { text: String(c.messageCount) }),
          h("td", { class: "small", text: fmtDate(c.updatedAt) }),
          h(
            "td",
            {},
            h("button", {
              class: "btn danger",
              text: tx("Delete"),
              onclick: async (e) => {
                if (!confirm(tx("Delete this conversation permanently?"))) return;
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
    h("div", { class: "row", style: "margin-bottom:12px" }, h("button", { class: "btn", text: tx("Export last 30 days (NDJSON)"), onclick: () => download("/conversations/export?days=30", "conversations.ndjson") })),
    h("div", { class: "card" }, h("table", {}, h("thead", {}, h("tr", {}, [tx("Conversation"), tx("Visitor"), tx("Messages"), tx("Last activity"), ""].map((t) => h("th", { text: t })))), table), more),
  );
  await load();
  if (!table.children.length) table.append(h("tr", {}, h("td", { colspan: 4, class: "muted", text: tx("No conversations yet.") })));
}

async function transcript(c) {
  const body = h("div", {}, h("p", { class: "muted", text: tx("Loading…") }));
  modal(c.title || tx("Conversation"), body, { wide: true });
  const [page, traces] = await Promise.all([api("GET", `/conversations/${c.id}/messages?limit=200`), runTraces(c.id)]);
  body.replaceChildren(
    ...page.items.map((m) =>
      h(
        "div",
        { class: "msg" },
        h(
          "div",
          { class: "who" },
          m.role,
          m.feedback ? h("span", { class: `badge ${m.feedback === "up" ? "ok" : "bad"}`, text: m.feedback === "up" ? " helpful" : " not helpful" }) : null,
          m.status !== "complete" ? h("span", { class: "badge warn", text: m.status }) : null,
          traceButton(traces.get(m.id)),
        ),
        h("div", { class: "body", text: m.content }),
        attachmentThumbs(c.id, m),
        m.citations.length ? h("div", { class: "small muted", text: tx("Sources: {0}", m.citations.map((x) => `[${x.index}] ${x.title}`).join(" · ")) }) : null,
      ),
    ),
  );
}

/** Images a visitor attached, fetched with the admin key (an <img src> cannot send it). */
function attachmentThumbs(conversationId, m) {
  if (!m.attachments?.length) return null;
  const row = h("div", { class: "thumbs" });
  for (const a of m.attachments) {
    const img = h("img", { alt: a.name || tx("Attached image"), title: a.name || "" });
    const btn = h("button", { class: "thumb", type: "button", "aria-label": tx("Open {0}", a.name || "image") }, img);
    row.append(btn);
    fetch(`/v1/admin/conversations/${encodeURIComponent(conversationId)}/attachments/${encodeURIComponent(a.id)}`, { headers: { authorization: `Bearer ${getKey()}` } })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((b) => {
        const url = URL.createObjectURL(b);
        img.src = url;
        btn.onclick = () => modal(a.name || tx("Attached image"), h("img", { src: url, alt: a.name || tx("Attached image"), style: "max-width:100%;height:auto" }), { wide: true });
      })
      .catch(() => btn.replaceChildren(h("span", { class: "small muted", text: tx("image unavailable") })));
  }
  return row;
}

/** Traces of a conversation's answers, by answer message id. */
async function runTraces(conversationId) {
  const r = await api("GET", `/conversations/${conversationId}/runs`).catch(() => ({ items: [] }));
  return new Map(r.items.filter((t) => t.answerMessageId).map((t) => [t.answerMessageId, t]));
}

function traceButton(t) {
  return t ? h("button", { class: "btn small", style: "margin-left:8px;padding:2px 8px", type: "button", text: tx("Details"), onclick: () => traceDialog(t) }) : null;
}

const ms = (n) => (n === null || n === undefined ? "—" : n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(1)} s`);

/** How one answer was produced: model, timings, tokens, passages, tools and the event timeline. */
function traceDialog(t) {
  const stat = (k, v) => h("div", { class: "card stat" }, h("div", { class: "v", style: "font-size:18px", text: v }), h("div", { class: "k", text: k }));
  const section = (title, content) => h("div", { style: "margin-top:16px" }, h("h3", { style: "margin:0 0 6px", text: title }), content);
  modal(
    tx("Answer details"),
    h(
      "div",
      {},
      h(
        "div",
        { class: "grid" },
        stat(tx("Total time"), ms(t.durationMs)),
        stat(tx("First word"), ms(t.firstTokenMs)),
        stat(tx("Tokens in / out"), `${t.usage.inputTokens} / ${t.usage.outputTokens}`),
        stat(tx("Model"), t.deploymentId ? `${t.modelAlias} → ${t.deploymentId}` : t.modelAlias),
        stat(tx("Assistant version"), `v${t.assistantVersion}`),
      ),
      t.error ? notice(`${t.error.code}: ${t.error.message ?? ""}`, true) : "",
      t.guardrail ? notice(tx("Stopped by a guardrail: {0}{1}", GUARDRAIL_LABELS[t.guardrail.kind] ?? t.guardrail.kind, t.guardrail.detail ? ` (${t.guardrail.detail})` : "")) : "",
      t.handoff ? notice(tx("Handed off to a person.")) : "",
      section(
        tx("Knowledge used"),
        h(
          "div",
          {},
          t.retrievalQuery ? h("p", { class: "small muted" }, tx("Searched for "), h("code", { text: t.retrievalQuery })) : "",
          t.sources.length
            ? h("ol", { class: "small" }, t.sources.map((x) => h("li", {}, h("strong", { text: x.title }), x.url ? h("div", {}, h("a", { href: x.url, target: "_blank", rel: "noopener", text: x.url })) : "", h("div", { class: "muted", text: x.snippet }))))
            : h("p", { class: "muted small", text: tx("No passages were given to the model.") }),
        ),
      ),
      section(
        tx("Tools"),
        t.tools.length
          ? h(
              "table",
              {},
              h("thead", {}, h("tr", {}, [tx("Tool"), tx("Kind"), tx("Started"), tx("Took"), tx("Result")].map((x) => h("th", { text: x })))),
              h(
                "tbody",
                {},
                t.tools.map((x) =>
                  h(
                    "tr",
                    {},
                    h("td", {}, x.title ?? x.name, h("div", { class: "muted small mono", text: x.name })),
                    h("td", { class: "small", text: { server: tx("ran on the server"), confirmation: tx("asked the visitor"), client: tx("ran in the page") }[x.kind] }),
                    h("td", { class: "small", text: `+${ms(x.startedMs)}` }),
                    h("td", { class: "small", text: ms(x.durationMs) }),
                    h("td", {}, x.isError === null ? h("span", { class: "badge warn", text: tx("no result") }) : h("span", { class: `badge ${x.isError ? "bad" : "ok"}`, text: x.isError ? "error" : "ok" })),
                  ),
                ),
              ),
            )
          : h("p", { class: "muted small", text: tx("No tools were called.") }),
      ),
      section(
        tx("Timeline"),
        h(
          "table",
          { class: "small" },
          h("tbody", {}, t.timeline.map((e) => h("tr", {}, h("td", { class: "mono", style: "width:90px", text: `+${ms(e.atMs)}` }), h("td", { class: "mono", text: e.type })))),
        ),
      ),
      h("p", { class: "muted small", text: tx("{0} text chunks streamed · run {1}", t.deltaCount, t.runId) }),
    ),
    { wide: true },
  );
}

async function download(path, filename) {
  const res = await fetch(`/v1/admin${path}`, { headers: { authorization: `Bearer ${getKey()}` } });
  if (!res.ok) return alert(tx("Export failed (HTTP {0})", res.status));
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
    h("div", { class: "row", style: "margin-bottom:12px" }, ...[7, 30, 90].map((d) => h("button", { class: `btn${d === days ? " primary" : ""}`, text: tx("{0} days", d), onclick: () => (location.hash = `#/insights?days=${d}`) }))),
    h(
      "div",
      { class: "grid", style: "margin-bottom:16px" },
      stat(tx("Conversations"), ins.conversations),
      ins.resolution ? stat(tx("Resolved by the assistant"), ins.resolution.rate === null ? "—" : `${Math.round(ins.resolution.rate * 100)}%`) : null,
      stat(tx("Questions"), ins.questions),
      stat(tx("Answered from knowledge"), pct(ins.questions - ins.unanswered, ins.questions)),
      stat(tx("Handoffs to people"), `${ins.handoffs} (${pct(ins.handoffs, ins.conversations)})`),
      stat(tx("Satisfaction"), ins.satisfaction === null ? "—" : `${Math.round(ins.satisfaction * 100)}%`),
      stat(tx("Ratings"), `${ins.feedbackUp} 👍 · ${ins.feedbackDown} 👎`),
    ),
    await topicsCard(days),
    ins.resolution?.engaged
      ? h(
          "p",
          { class: "muted small", style: "margin:-8px 0 16px" },
          tx("Resolved: {0} of {1} conversations with an answer. Not resolved: ", ins.resolution.resolved, ins.resolution.engaged) +
            tx("{0} handed to a person, {1} with an answer rated not helpful, ", ins.resolution.handedOff, ins.resolution.downvoted) +
            tx("{0} whose last question found no knowledge (a conversation can count in several).", ins.resolution.noKnowledge),
        )
      : null,
    list(
      tx("Knowledge gaps"),
      tx("Questions for which no relevant knowledge was found. Writing or fixing these docs improves answers the most."),
      ins.knowledgeGaps.map((q) =>
        h(
          "tr",
          {},
          h("td", { text: q.question }),
          h("td", { class: "small muted", text: `${q.count}×` }),
          h("td", { class: "small muted", text: fmtDate(q.lastAskedAt) }),
          allowed("config:write") ? h("td", { class: "row" }, h("button", { class: "btn", text: tx("Add to evals"), onclick: () => addToSuite(q.question) })) : null,
        ),
      ),
      tx("No gaps in this period."),
    ),
    ins.searches?.count
      ? list(
          tx("Searches without results ({0} of {1} searches)", ins.searches.withoutResults, ins.searches.count),
          tx("Queries typed in a search box using the search API that matched no knowledge."),
          ins.searches.gaps.map((q) => h("tr", {}, h("td", { text: q.question }), h("td", { class: "small muted", text: `${q.count}×` }), h("td", { class: "small muted", text: fmtDate(q.lastAskedAt) }))),
          tx("Every search found something."),
        )
      : null,
    list(
      tx("Answers rated not helpful"),
      null,
      ins.downvoted.map((d) =>
        h(
          "tr",
          {},
          h("td", {}, h("strong", { text: d.question || tx("(question not found)") }), h("div", { class: "small muted clamp", text: d.answer }), d.comment ? h("div", { class: "small", text: `“${d.comment}”` }) : null),
          h("td", { class: "small muted", text: fmtDate(d.createdAt) }),
        ),
      ),
      tx("No negative ratings in this period."),
    ),
    list(
      tx("Top questions"),
      null,
      ins.topQuestions.map((q) => h("tr", {}, h("td", { text: q.question }), h("td", { class: "small muted", text: `${q.count}×` }))),
      tx("No questions yet."),
    ),
    list(
      tx("Tools"),
      null,
      ins.tools.map((t) => h("tr", {}, h("td", {}, h("code", { text: t.name })), h("td", { class: "small", text: tx("{0} calls", t.calls) }), h("td", { class: `small${t.errors ? " bad" : " muted"}`, text: tx("{0} errors", t.errors) }))),
      tx("No tool calls in this period."),
    ),
    list(
      tx("Guardrails"),
      tx("Questions refused and answers replaced by the assistants' guardrails."),
      ins.guardrails.map((g) => h("tr", {}, h("td", { text: GUARDRAIL_LABELS[g.kind] ?? g.kind }), h("td", { class: "small", text: `${g.count}×` }))),
      tx("Nothing was blocked in this period."),
    ),
  );
}

const GUARDRAIL_LABELS = {
  term: tx("Blocked term in the question"),
  topic: tx("Blocked topic"),
  harmful: tx("Harmful request (moderation)"),
  injection: tx("Prompt injection attempt"),
  answer_term: tx("Answer contained a blocked term (replaced)"),
};

// ------------------------------------------------------------------ actions
async function actions(main) {
  const list = await api("GET", "/actions");
  main.append(
    h("p", { class: "muted", text: tx("HTTP endpoints the assistant can call as tools: look up an order, create a ticket, book a demo. Requests are signed (EA-Signature) with the widget identity secret.") }),
    h("div", { class: "row", style: "margin-bottom:12px" }, h("button", { class: "btn primary", onclick: () => actionForm(null), text: tx("New action") })),
    h(
      "div",
      { class: "card" },
      list.length
        ? h(
            "table",
            {},
            h("thead", {}, h("tr", {}, [tx("Action"), tx("Request"), tx("Rules"), ""].map((t) => h("th", { text: t })))),
            h(
              "tbody",
              {},
              list.map((x) =>
                h(
                  "tr",
                  {},
                  h("td", {}, h("strong", { text: x.title }), h("div", {}, h("code", { text: x.name })), h("div", { class: "small muted", text: x.description })),
                  h("td", { class: "small mono", text: `${x.method} ${x.url}` }),
                  h("td", {}, x.enabled ? null : h("span", { class: "badge", text: tx("disabled") }), x.confirm ? h("span", { class: "badge warn", text: tx("asks first") }) : null, x.requireUser ? h("span", { class: "badge", text: tx("signed-in only") }) : null),
                  h(
                    "td",
                    { class: "row" },
                    h("button", { class: "btn", onclick: () => actionForm(x), text: tx("Edit") }),
                    h("button", { class: "btn", onclick: () => actionTest(x), text: tx("Test") }),
                    h("button", {
                      class: "btn danger",
                      text: tx("Delete"),
                      onclick: async () => {
                        if (!confirm(tx("Delete action \"{0}\"?", x.title))) return;
                        await api("DELETE", `/actions/${x.id}`);
                        route();
                      },
                    }),
                  ),
                ),
              ),
            ),
          )
        : h("p", { class: "muted", text: tx("No actions yet.") }),
    ),
  );
}

function actionForm(x) {
  const f = {
    name: h("input", { value: x?.name ?? "", required: true, pattern: "[a-zA-Z][a-zA-Z0-9_\\-]{0,63}", placeholder: "get_order_status" }),
    title: h("input", { value: x?.title ?? "", required: true, placeholder: tx("Checking your order") }),
    description: h("textarea", { value: x?.description ?? "", rows: 3, required: true, placeholder: tx("When the model should use it, and what it returns.") }),
    method: h("select", {}, ["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => h("option", { value: m, text: m }))),
    url: h("input", { value: x?.url ?? "", required: true, placeholder: "https://api.example.com/orders/{orderId}" }),
    parameters: h("textarea", { class: "mono", rows: 7, value: JSON.stringify(x?.parameters ?? { type: "object", properties: { orderId: { type: "string", description: tx("Order number") } }, required: ["orderId"] }, null, 2) }),
    headers: h("textarea", { class: "mono", rows: 3, value: "", placeholder: x?.headerNames?.length ? tx("Configured: {0}. Leave empty to keep.", x.headerNames.join(", ")) : '{ "Authorization": "Bearer …" }' }),
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
          msg.replaceChildren(notice(err instanceof SyntaxError ? tx("Invalid JSON: {0}", err.message) : errorText(err), true));
        }
      },
    },
    h("div", { class: "two" }, field(tx("Tool name"), f.name, tx("What the model calls.")), field(tx("Label"), f.title, tx("Shown to visitors while it runs."))),
    field(tx("Description"), f.description),
    h("div", { class: "two" }, field(tx("Method"), f.method), field(tx("Timeout (ms)"), f.timeoutMs)),
    field(tx("URL"), f.url, "{name} placeholders are filled from arguments. Other arguments go to the query string (GET, DELETE) or the JSON body."),
    field(tx("Parameters (JSON Schema)"), f.parameters),
    field(tx("Headers (JSON, stored encrypted)"), f.headers),
    h("label", { class: "check" }, f.confirm, tx("Ask the visitor before each call (use for anything that changes data)")),
    h("label", { class: "check" }, f.requireUser, tx("Signed-in users only; forward their identity as EA-User-* headers")),
    h("label", { class: "check" }, f.enabled, tx("Enabled")),
    msg,
    h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit", text: x ? tx("Save") : tx("Create") })),
  );
  const dlg = modal(x ? tx("Edit {0}", x.title) : tx("New action"), form, { wide: true });
}

// ------------------------------------------------------------------ playbooks
async function playbooks(main) {
  const { items } = await api("GET", "/playbooks");
  const canWrite = allowed("config:write");
  main.append(
    h("p", { class: "muted", text: tx("Procedures in plain language: how to handle a refund, reset a password, troubleshoot a device. The assistant sees each playbook's name and description, reads the steps when a request matches, and follows them (asking for details and using the actions they mention). Attach playbooks to assistants in their settings.") }),
    canWrite ? h("div", { class: "row", style: "margin-bottom:12px" }, h("button", { class: "btn primary", onclick: () => playbookForm(null), text: tx("New playbook") })) : "",
    h(
      "div",
      { class: "card" },
      items.length
        ? h(
            "table",
            {},
            h("thead", {}, h("tr", {}, [tx("Playbook"), tx("When to use"), tx("Steps"), ""].map((t) => h("th", { text: t })))),
            h(
              "tbody",
              {},
              items.map((x) =>
                h(
                  "tr",
                  {},
                  h("td", {}, h("strong", { text: x.title }), h("div", {}, h("code", { text: x.name })), x.enabled ? null : h("span", { class: "badge", text: tx("disabled") })),
                  h("td", { class: "small", text: x.description }),
                  h("td", { class: "small muted", text: tx("{0} lines", x.instructions.split("\n").filter((l) => l.trim()).length) }),
                  h(
                    "td",
                    { class: "row" },
                    h("button", { class: "btn", onclick: () => playbookForm(x), text: canWrite ? tx("Edit") : tx("View") }),
                    canWrite
                      ? h("button", {
                          class: "btn danger",
                          text: tx("Delete"),
                          onclick: async () => {
                            if (!confirm(tx("Delete playbook \"{0}\"? It is removed from every assistant.", x.title))) return;
                            await api("DELETE", `/playbooks/${x.id}`);
                            route();
                          },
                        })
                      : null,
                  ),
                ),
              ),
            ),
          )
        : h("p", { class: "muted", text: tx("No playbooks yet.") }),
    ),
  );
}

function playbookForm(x) {
  const f = {
    name: h("input", { value: x?.name ?? "", required: true, pattern: "[a-z][a-z0-9_\\-]{1,63}", placeholder: "refund_request" }),
    title: h("input", { value: x?.title ?? "", required: true, maxlength: 120, placeholder: tx("Refunds") }),
    description: h("textarea", { value: x?.description ?? "", rows: 2, required: true, minlength: 10, maxlength: 1000, placeholder: tx("When a customer asks for their money back for an order.") }),
    instructions: h("textarea", {
      value: x?.instructions ?? "",
      rows: 12,
      required: true,
      maxlength: 20000,
      placeholder: tx("1. Ask for the order number if you don't have it.\n2. Look it up with get_order_status.\n3. If it was delivered more than 30 days ago, explain the policy and offer store credit.\n4. Otherwise, call create_refund and confirm the amount.\n5. If the customer is upset or the amount is over 500 EUR, hand off to a person."),
    }),
    enabled: h("input", { type: "checkbox", checked: x?.enabled ?? true }),
  };
  const msg = h("div");
  const form = h(
    "form",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        const body = { name: f.name.value.trim(), title: f.title.value.trim(), description: f.description.value.trim(), instructions: f.instructions.value.trim(), enabled: f.enabled.checked };
        try {
          await api(x ? "PATCH" : "POST", x ? `/playbooks/${x.id}` : "/playbooks", body);
          dlg.close();
          route();
        } catch (err) {
          msg.replaceChildren(notice(errorText(err), true));
        }
      },
    },
    h("div", { class: "two" }, field(tx("Name"), f.name, tx("Lowercase, what the model uses to open it.")), field(tx("Title"), f.title)),
    field(tx("When to use"), f.description, tx("The model decides from this alone whether the playbook applies. Be specific.")),
    field(tx("Steps"), f.instructions, tx("Plain language or Markdown. Conditions (if…, otherwise…), what to ask, which actions to call, when to hand off.")),
    h("label", { class: "check" }, f.enabled, tx("Enabled")),
    msg,
    allowed("config:write") ? h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit", text: x ? tx("Save") : tx("Create") })) : "",
  );
  const dlg = modal(x ? x.title : tx("New playbook"), form, { wide: true });
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
          out.replaceChildren(notice(err instanceof SyntaxError ? tx("Invalid JSON: {0}", err.message) : errorText(err), true));
        }
      },
    },
    field(tx("Arguments (JSON)"), args),
    h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit", text: tx("Call") })),
    out,
  );
  modal(tx("Test {0}", x.title), form, { wide: true });
}

// ------------------------------------------------------------------ MCP servers
async function mcpServers(main) {
  const list = await api("GET", "/mcp-servers");
  const endpoint = `${location.origin}/mcp`;
  main.append(
    h(
      "div",
      { class: "card" },
      h("h2", { text: tx("Use this knowledge from other AI tools") }),
      h("p", { class: "muted", text: tx("This server is itself an MCP server (Streamable HTTP, protocol 2026-07-28 and 2025-xx). Create an API key with the mcp scope under Settings, then add it to your MCP client:") }),
      h("pre", { text: JSON.stringify({ mcpServers: { "embed-assistant": { type: "http", url: endpoint, headers: { Authorization: "Bearer ea_mcp_…" } } } }, null, 2) }),
      h("p", { class: "small muted", text: tx("Tools: search_knowledge, ask, get_document, list_sources. The key's access tags decide which knowledge it can read.") }),
    ),
    h("h2", { text: tx("Connected MCP servers") }),
    h("p", { class: "muted", text: tx("Give assistants the tools of remote MCP servers (ticketing, CRM, booking, internal APIs). Attach a server to an assistant under Assistants.") }),
    h("div", { class: "row", style: "margin-bottom:12px" }, h("button", { class: "btn primary", onclick: () => mcpForm(null), text: tx("Connect MCP server") })),
    h(
      "div",
      { class: "card" },
      list.length
        ? h(
            "table",
            {},
            h("thead", {}, h("tr", {}, [tx("Server"), tx("Tools"), tx("Status"), ""].map((t) => h("th", { text: t })))),
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
                          return h("div", { class: off ? "muted" : "" }, h("code", { text: t.name }), t.readOnly ? h("span", { class: "badge", text: tx("read-only") }) : null, off ? tx(" (hidden)") : "");
                        })
                      : h("span", { class: "muted", text: "—" }),
                  ),
                  h(
                    "td",
                    { class: "small" },
                    x.lastError ? h("div", { class: "bad clamp", text: x.lastError }) : h("span", { class: "badge ok", text: x.protocolVersion ?? "ok" }),
                    x.enabled ? null : h("span", { class: "badge", text: tx("disabled") }),
                    x.confirm ? h("span", { class: "badge warn", text: tx("asks first") }) : null,
                    x.requireUser ? h("span", { class: "badge", text: tx("signed-in only") }) : null,
                    h("div", { class: "muted", text: x.refreshedAt ? tx("Checked {0}", fmtDate(x.refreshedAt)) : "" }),
                  ),
                  h(
                    "td",
                    { class: "row" },
                    h("button", { class: "btn", onclick: () => mcpForm(x), text: tx("Edit") }),
                    h("button", {
                      class: "btn",
                      text: tx("Refresh"),
                      onclick: async (e) => {
                        e.target.disabled = true;
                        await api("POST", `/mcp-servers/${x.id}/refresh`).finally(() => route());
                      },
                    }),
                    h("button", { class: "btn", disabled: !x.tools.length, onclick: () => mcpTest(x), text: tx("Test") }),
                    h("button", {
                      class: "btn danger",
                      text: tx("Remove"),
                      onclick: async () => {
                        if (!confirm(tx("Remove MCP server \"{0}\"?", x.title))) return;
                        await api("DELETE", `/mcp-servers/${x.id}`);
                        route();
                      },
                    }),
                  ),
                ),
              ),
            ),
          )
        : h("p", { class: "muted", text: tx("No MCP servers connected.") }),
    ),
  );
}

function mcpForm(x) {
  const f = {
    name: h("input", { value: x?.name ?? "", required: true, pattern: "[a-z][a-z0-9_]{0,23}", placeholder: "helpdesk" }),
    title: h("input", { value: x?.title ?? "", required: true, placeholder: tx("Helpdesk") }),
    url: h("input", { value: x?.url ?? "", required: true, placeholder: "https://mcp.example.com/mcp" }),
    headers: h("textarea", { class: "mono", rows: 3, value: "", placeholder: x?.headerNames?.length ? tx("Configured: {0}. Leave empty to keep.", x.headerNames.join(", ")) : '{ "Authorization": "Bearer …" }' }),
    allowedTools: h("input", { value: x?.allowedTools?.join(", ") ?? "", placeholder: tx("All tools") }),
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
            msg.replaceChildren(notice(tx("Saved, but connecting failed: {0}", saved.lastError), true));
            x = saved;
            return;
          }
          dlg.close();
          route();
        } catch (err) {
          msg.replaceChildren(notice(err instanceof SyntaxError ? tx("Invalid JSON: {0}", err.message) : errorText(err), true));
        }
      },
    },
    h("div", { class: "two" }, field(tx("Name"), f.name, tx("Prefix of its tools: name__tool.")), field(tx("Label"), f.title)),
    field(tx("URL (Streamable HTTP endpoint)"), f.url),
    field(tx("Headers (JSON, stored encrypted)"), f.headers, tx("For example an API key or bearer token for the server.")),
    field(tx("Allowed tools"), f.allowedTools, tx("Comma-separated tool names. Empty exposes every tool the server lists.")),
    h("label", { class: "check" }, f.confirm, tx("Ask the visitor before each call (tools the server marks read-only run directly)")),
    h("label", { class: "check" }, f.requireUser, tx("Signed-in users only")),
    h("label", { class: "check" }, f.enabled, tx("Enabled")),
    msg,
    h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit", text: x ? tx("Save") : tx("Connect") })),
  );
  const dlg = modal(x ? tx("Edit {0}", x.title) : tx("Connect MCP server"), form, { wide: true });
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
          out.replaceChildren(notice(err instanceof SyntaxError ? tx("Invalid JSON: {0}", err.message) : errorText(err), true));
        }
      },
    },
    field(tx("Tool"), tool),
    schema,
    field(tx("Arguments (JSON)"), args),
    h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit", text: tx("Call") })),
    out,
  );
  modal(tx("Test {0}", x.title), form, { wide: true });
}

// ------------------------------------------------------------------ webhooks
const WEBHOOK_EVENTS = ["conversation.created", "message.completed", "feedback.submitted", "handoff.requested", "source.synced", "audit.recorded"];

async function webhooks(main) {
  const list = await api("GET", "/webhooks");
  main.append(
    h("p", { class: "muted", text: tx("Send events to your helpdesk, CRM, chat or automation tool. Signed per the Standard Webhooks spec; failed deliveries are retried for about 4 hours.") }),
    h("div", { class: "row", style: "margin-bottom:12px" }, h("button", { class: "btn primary", onclick: () => webhookForm(null), text: tx("New webhook") })),
    h(
      "div",
      { class: "card" },
      list.length
        ? h(
            "table",
            {},
            h("thead", {}, h("tr", {}, [tx("Endpoint"), tx("Events"), ""].map((t) => h("th", { text: t })))),
            h(
              "tbody",
              {},
              list.map((w) =>
                h(
                  "tr",
                  {},
                  h("td", {}, h("div", { class: "mono small", text: w.url }), w.description ? h("div", { class: "small muted", text: w.description }) : null, w.enabled ? null : h("span", { class: "badge", text: tx("disabled") })),
                  h("td", {}, w.events.map((e) => h("span", { class: "badge", text: e }))),
                  h(
                    "td",
                    { class: "row" },
                    h("button", { class: "btn", onclick: () => webhookForm(w), text: tx("Edit") }),
                    h("button", {
                      class: "btn",
                      text: tx("Send test"),
                      onclick: async (e) => {
                        const r = await api("POST", `/webhooks/${w.id}/test`);
                        e.target.textContent = r.ok ? tx("OK ({0})", r.status) : tx("Failed: {0}", r.error ?? r.status);
                      },
                    }),
                    h("button", { class: "btn", onclick: () => deliveries(w), text: tx("Deliveries") }),
                    h("button", {
                      class: "btn danger",
                      text: tx("Delete"),
                      onclick: async () => {
                        if (!confirm(tx("Delete this webhook?"))) return;
                        await api("DELETE", `/webhooks/${w.id}`);
                        route();
                      },
                    }),
                  ),
                ),
              ),
            ),
          )
        : h("p", { class: "muted", text: tx("No webhooks yet.") }),
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
          if (!w) form.replaceChildren(h("p", { text: tx("Webhook created. Verify deliveries with this signing secret:") }), secretBox(r.secret), h("button", { class: "btn", type: "button", text: tx("Done"), onclick: () => (dlg.close(), route()) }));
          else (dlg.close(), route());
        } catch (err) {
          msg.replaceChildren(notice(errorText(err), true));
        }
      },
    },
    field(tx("Endpoint URL"), url),
    field(tx("Description"), description),
    h("fieldset", { class: "box" }, h("legend", { text: tx("Events") }), checks),
    h("label", { class: "check" }, enabled, tx("Enabled")),
    msg,
    h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit", text: w ? tx("Save") : tx("Create") })),
  );
  const dlg = modal(w ? tx("Edit webhook") : tx("New webhook"), form);
}

async function deliveries(w) {
  const body = h("div", {}, h("p", { class: "muted", text: tx("Loading…") }));
  modal(tx("Recent deliveries"), body, { wide: true });
  const rows = await api("GET", `/webhooks/${w.id}/deliveries`);
  body.replaceChildren(
    rows.length
      ? h(
          "table",
          {},
          h("thead", {}, h("tr", {}, [tx("Event"), tx("Status"), tx("Attempts"), tx("Last error"), tx("Created")].map((t) => h("th", { text: t })))),
          h("tbody", {}, rows.map((d) => h("tr", {}, h("td", {}, h("code", { text: d.event })), h("td", {}, h("span", { class: `badge ${d.status === "succeeded" ? "ok" : d.status === "failed" ? "bad" : "warn"}`, text: d.status })), h("td", { text: String(d.attempts) }), h("td", { class: "small", text: d.lastError ?? "" }), h("td", { class: "small", text: fmtDate(d.createdAt) })))),
        )
      : h("p", { class: "muted", text: tx("No deliveries yet.") }),
  );
}

// ------------------------------------------------------------------ settings
async function settings(main) {
  const [st, keys] = await Promise.all([api("GET", "/settings"), api("GET", "/keys")]);
  const retention = h("input", { type: "number", min: 1, max: 3650, value: st.retentionDays ?? "", placeholder: tx("Keep forever") });
  const budget = h("input", { type: "number", min: 1, value: st.dailyTokenBudget ?? "", placeholder: tx("Server default") });
  const digest = h("input", { type: "checkbox", checked: !!st.weeklyDigest });
  const msg = h("div");
  const keyRows = h("tbody");
  for (const k of keys) {
    keyRows.append(
      h(
        "tr",
        {},
        h("td", {}, h("strong", { text: k.name }), h("div", { class: "small mono muted", text: `${k.prefix}…` })),
        h("td", {}, k.scopes.map((x) => h("span", { class: "badge", text: x })), k.scopes.includes("mcp") ? h("div", { class: "small muted", text: tx("access: {0}", k.access.join(", ")) }) : null),
        h("td", { class: "small", text: k.lastUsedAt ? fmtDate(k.lastUsedAt) : tx("never") }),
        h("td", {}, h("button", { class: "btn danger", text: tx("Revoke"), onclick: async () => { if (!confirm(tx("Revoke \"{0}\"?", k.name))) return; try { await api("DELETE", `/keys/${k.id}`); route(); } catch (err) { alert(errorText(err)); } } })),
      ),
    );
  }
  const newName = h("input", { placeholder: tx("Key name"), required: true });
  const newScope = h("select", {}, h("option", { value: "admin", text: tx("admin: full admin API") }), h("option", { value: "mcp", text: tx("mcp: MCP endpoint only (read knowledge, ask)") }));
  const newAccess = h("input", { value: "public", placeholder: tx("public, users, staff") });
  const keyMsg = h("div");
  main.append(
    h(
      "div",
      { class: "card" },
      h("h2", { text: tx("Data and usage") }),
      h(
        "form",
        {
          onsubmit: async (e) => {
            e.preventDefault();
            try {
              await api("PATCH", "/settings", { retentionDays: retention.value ? Number(retention.value) : null, dailyTokenBudget: budget.value ? Number(budget.value) : null, weeklyDigest: digest.checked });
              msg.replaceChildren(notice(tx("Saved.")));
            } catch (err) {
              msg.replaceChildren(notice(errorText(err), true));
            }
          },
        },
        h("div", { class: "two" }, field(tx("Delete conversations after (days)"), retention, tx("Empty keeps them forever. Deletion is permanent.")), field(tx("Daily model-token budget"), budget, tx("Shared by widgets without their own budget."))),
        h("label", { class: "check" }, digest, tx("Weekly insights digest")),
        h("p", { class: "muted small", text: tx("Every 7 days, analyse the week's questions into topics with suggested articles (Insights) and send them to webhooks subscribed to insights.digest, e.g. to post in your team chat.") }),
        msg,
        h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit", text: tx("Save") })),
      ),
    ),
    h(
      "div",
      { class: "card" },
      h("h2", { text: tx("API keys") }),
      h("table", {}, h("thead", {}, h("tr", {}, [tx("Name"), tx("Scope"), tx("Last used"), ""].map((t) => h("th", { text: t })))), keyRows),
      h(
        "form",
        {
          style: "margin-top:12px",
          onsubmit: async (e) => {
            e.preventDefault();
            try {
              const r = await api("POST", "/keys", { name: newName.value.trim(), scopes: [newScope.value], access: csv(newAccess.value) });
              keyMsg.replaceChildren(h("p", { text: tx("Key created. It is shown only once:") }), secretBox(r.key), h("button", { class: "btn", type: "button", text: tx("Done"), onclick: () => route() }));
            } catch (err) {
              keyMsg.replaceChildren(notice(errorText(err), true));
            }
          },
        },
        h("div", { class: "two" }, field(tx("Name"), newName), field(tx("Scope"), newScope)),
        field(tx("Knowledge access (mcp keys)"), newAccess, tx("Comma-separated access tags the key may read.")),
        keyMsg,
        h("div", { class: "row" }, h("button", { class: "btn", type: "submit", text: tx("Create key") })),
      ),
    ),
    h(
      "div",
      { class: "card" },
      h("h2", { text: tx("Erase a visitor's data") }),
      (() => {
        const subject = h("input", { placeholder: tx("user:123 or anon:…") });
        const out = h("div");
        return h(
          "form",
          {
            onsubmit: async (e) => {
              e.preventDefault();
              if (!subject.value.trim() || !confirm(tx("Delete every conversation of {0}?", subject.value.trim()))) return;
              const r = await api("DELETE", `/subjects/${encodeURIComponent(subject.value.trim())}`);
              out.replaceChildren(notice(tx("Deleted {0} conversation(s).", r.deletedConversations)));
            },
          },
          field(tx("Subject id"), subject, tx("Shown in Conversations. Signed-in users are user:<sub> from your token.")),
          out,
          h("div", { class: "row" }, h("button", { class: "btn danger", type: "submit", text: tx("Erase") })),
        );
      })(),
    ),
  );
}

// ------------------------------------------------------------------ inbox (live handoffs)
const INBOX_TABS = [
  ["waiting", tx("Waiting")],
  ["active", tx("Active")],
  ["mine", tx("Mine")],
  ["resolved", tx("Resolved")],
];

async function inbox(main) {
  const params = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const tab = params.get("tab") ?? "waiting";
  const openId = params.get("c");
  const go = (t, c) => (location.hash = `#/inbox?tab=${t}${c ? `&c=${encodeURIComponent(c)}` : ""}`);
  const query = tab === "mine" ? "handoff=active&assignee=me" : `handoff=${tab}`;
  const page = await api("GET", `/conversations?limit=100&${query}`);
  const canReply = allowed("conversations:reply");

  const list = h(
    "div",
    { class: "inbox-list" },
    page.items.length
      ? page.items.map((c) =>
          h(
            "button",
            { class: `inbox-item${c.id === openId ? " current" : ""}`, onclick: () => go(tab, c.id) },
            h("strong", { text: c.title || tx("(untitled)") }),
            h("span", { class: "small muted", text: c.handoffReason || c.subjectId.slice(0, 40) }),
            h("span", { class: "small muted" }, c.mode === "human" ? h("span", { class: "badge ok", text: c.assignee?.name ?? "person" }) : null, ` ${fmtDate(c.updatedAt)}`),
          ),
        )
      : h("p", { class: "muted small", style: "padding:8px", text: tab === "waiting" ? tx("Nobody is waiting. Handoffs appear here as soon as a visitor asks for a person.") : tx("Nothing here.") }),
  );
  const pane = h("div", { class: "inbox-pane card" });
  main.append(
    h("div", { class: "row", style: "margin-bottom:12px" }, INBOX_TABS.map(([t, label]) => h("button", { class: `btn${t === tab ? " primary" : ""}`, text: label, onclick: () => go(t) }))),
    h("div", { class: "inbox" }, h("div", { class: "card", style: "padding:6px" }, list), pane),
  );

  if (!openId) pane.append(h("p", { class: "muted", text: tx("Choose a conversation.") }));
  else {
    const conv = await api("GET", `/conversations/${encodeURIComponent(openId)}`);
    // After taking over or handing back, follow the conversation to the tab it now belongs to.
    await conversationPane(pane, openId, conv, canReply, (next) => go(next ?? tab, openId));
  }

  // Refresh the queue while the page is open.
  const tick = () => {
    if (!location.hash.startsWith("#/inbox")) return;
    // Don't re-render under someone typing a reply.
    if (document.querySelector("dialog[open]") || (pane.contains(document.activeElement) && document.activeElement.value)) pollTimer = setTimeout(tick, 8000);
    else route();
  };
  pollTimer = setTimeout(tick, 8000);
}

async function conversationPane(pane, id, conv, canReply, refresh) {
  const thread = h("div", { class: "inbox-thread" });
  const header = h("div", { class: "top", style: "margin-bottom:8px" });
  let state = conv;
  let lastCount = -1;
  const draw = async () => {
    const msgs = await api("GET", `/conversations/${id}/messages?limit=200`);
    if (msgs.items.length === lastCount) return;
    lastCount = msgs.items.length;
    const traces = await runTraces(id);
    thread.replaceChildren(
      ...msgs.items.map((m) =>
        h(
          "div",
          { class: `bubble ${m.role === "user" ? "visitor" : m.author ? "person" : "ai"}` },
          h("div", { class: "who" }, m.role === "user" ? tx("Visitor") : m.author ? m.author.name : tx("Assistant"), traceButton(traces.get(m.id))),
          h("div", { class: "body", text: m.content }),
          attachmentThumbs(id, m),
          h("div", { class: "small muted", text: fmtDate(m.createdAt) }),
        ),
      ),
    );
    thread.scrollTop = thread.scrollHeight;
  };
  const act = async (fn, nextTab) => {
    try {
      await fn();
      refresh(nextTab);
      route();
    } catch (err) {
      alert(errorText(err));
    }
  };
  const human = state?.mode === "human";
  header.append(
    h("div", {}, h("h2", { style: "margin:0", text: state?.title || tx("Conversation") }), h("div", { class: "small muted", text: state ? `${state.subjectId}${state.handoffReason ? ` · ${state.handoffReason}` : ""}` : "" })),
    canReply
      ? h(
          "div",
          { class: "row" },
          human ? null : h("button", { class: "btn primary", text: tx("Take over"), onclick: () => act(() => api("POST", `/conversations/${id}/assign`, {}), "active") }),
          human ? h("button", { class: "btn", text: tx("Hand back to assistant"), onclick: () => act(() => api("POST", `/conversations/${id}/release`, { resolve: false }), "waiting") }) : null,
          state?.handoffResolvedAt && !human ? null : h("button", { class: "btn", text: tx("Resolve"), onclick: () => act(() => api("POST", `/conversations/${id}/release`, { resolve: true }), "resolved") }),
        )
      : null,
  );
  const input = h("textarea", { placeholder: human ? tx("Reply to the visitor…") : tx("Replying takes the conversation over from the assistant…"), rows: 3 });
  const form = canReply
    ? h(
        "form",
        {
          onsubmit: async (e) => {
            e.preventDefault();
            const content = input.value.trim();
            if (!content) return;
            try {
              await api("POST", `/conversations/${id}/reply`, { content });
              input.value = "";
              if (!human) {
                refresh("active");
                return route();
              }
              await draw();
            } catch (err) {
              alert(errorText(err));
            }
          },
        },
        input,
        h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit", text: tx("Send") }), h("span", { class: "small muted", text: tx("Ctrl+Enter to send. The visitor sees your reply instantly.") })),
      )
    : null;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) form?.requestSubmit();
  });
  pane.append(header, thread, form);
  await draw();
  // Live updates of the open conversation.
  const timer = setInterval(() => (pane.isConnected ? draw().catch(() => {}) : clearInterval(timer)), 2500);
}

// ------------------------------------------------------------------ team and sign-in
const ROLES = [
  ["owner", tx("Owner: everything, including other owners")],
  ["admin", tx("Admin: everything except managing owners")],
  ["editor", tx("Editor: maintain knowledge")],
  ["analyst", tx("Analyst: conversations, exports and insights")],
  ["agent", tx("Agent: read and answer conversations")],
];
const roleSelect = (value, { owner = me?.role === "owner", exclude = [] } = {}) =>
  h("select", {}, ROLES.filter(([r]) => (owner || r !== "owner") && !exclude.includes(r)).map(([r, label]) => h("option", { value: r, text: label, selected: r === value })));

async function team(main) {
  const [users, sso] = await Promise.all([api("GET", "/users"), api("GET", "/sso")]);
  const rows = h("tbody");
  for (const u of users) {
    const self = me.type === "user" && me.id === u.id;
    const locked = self || (u.role === "owner" && me.role !== "owner");
    const role = roleSelect(u.role);
    role.disabled = locked;
    role.onchange = async () => {
      try {
        await api("PATCH", `/users/${u.id}`, { role: role.value });
      } catch (err) {
        alert(errorText(err));
        route();
      }
    };
    rows.append(
      h(
        "tr",
        {},
        h("td", {}, h("strong", { text: u.name ?? u.email }), h("div", { class: "small muted", text: u.email }), self ? h("span", { class: "badge", text: "you" }) : null),
        h("td", {}, role),
        h("td", {}, u.disabled ? h("span", { class: "badge bad", text: tx("disabled") }) : u.lastLoginAt ? h("span", { class: "badge ok", text: tx("active") }) : h("span", { class: "badge warn", text: tx("invited") })),
        h("td", { class: "small", text: u.lastLoginAt ? fmtDate(u.lastLoginAt) : "never" }),
        h(
          "td",
          { class: "row" },
          locked
            ? null
            : [
                h("button", { class: "btn", text: u.disabled ? tx("Enable") : tx("Disable"), onclick: async () => { try { await api("PATCH", `/users/${u.id}`, { disabled: !u.disabled }); route(); } catch (err) { alert(errorText(err)); } } }),
                h("button", { class: "btn danger", text: tx("Remove"), onclick: async () => { if (!confirm(tx("Remove {0}?", u.email))) return; try { await api("DELETE", `/users/${u.id}`); route(); } catch (err) { alert(errorText(err)); } } }),
              ],
        ),
      ),
    );
  }
  if (!users.length) rows.append(h("tr", {}, h("td", { colspan: 5, class: "muted", text: tx("No console users yet. Invite people below; they sign in with single sign-on.") })));

  const email = h("input", { type: "email", required: true, placeholder: "name@company.com" });
  const name = h("input", { placeholder: tx("Optional") });
  const role = roleSelect("editor");
  const inviteMsg = h("div");

  const issuer = h("input", { value: sso.issuer, required: true, placeholder: "https://login.microsoftonline.com/<tenant-id>/v2.0" });
  const clientId = h("input", { value: sso.clientId, required: true });
  const clientSecret = h("input", { type: "password", autocomplete: "off", placeholder: sso.hasClientSecret ? tx("Stored. Leave empty to keep it.") : tx("Client secret") });
  const domains = h("input", { value: sso.allowedDomains.join(", "), placeholder: tx("company.com, subsidiary.com") });
  const auto = h("select", {}, h("option", { value: "", text: tx("Off: invited people only") }), ROLES.filter(([r]) => r !== "owner").map(([r, label]) => h("option", { value: r, text: tx("On, as {0}", label), selected: sso.autoProvisionRole === r })));
  const enabled = h("input", { type: "checkbox", checked: sso.updatedAt ? sso.enabled : true });
  const ssoMsg = h("div");

  main.append(
    h("div", { class: "card" }, h("h2", { text: tx("People") }), h("table", {}, h("thead", {}, h("tr", {}, [tx("Person"), tx("Role"), tx("Status"), tx("Last sign-in"), ""].map((x) => h("th", { text: x })))), rows)),
    h(
      "div",
      { class: "card" },
      h("h2", { text: tx("Invite") }),
      h(
        "form",
        {
          onsubmit: async (e) => {
            e.preventDefault();
            try {
              await api("POST", "/users", { email: email.value.trim(), name: name.value.trim() || null, role: role.value });
              route();
            } catch (err) {
              inviteMsg.replaceChildren(notice(errorText(err), true));
            }
          },
        },
        h("div", { class: "two" }, field(tx("E-mail"), email, tx("They sign in with single sign-on using this address.")), field(tx("Name"), name)),
        field(tx("Role"), role),
        inviteMsg,
        h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit", text: tx("Invite") })),
      ),
    ),
    h(
      "div",
      { class: "card" },
      h("h2", { text: tx("Single sign-on (OpenID Connect)") }),
      h("p", { class: "muted small", text: tx("Works with Microsoft Entra ID, Google Workspace, Okta, Auth0, Keycloak, Authentik, Zitadel and any OpenID Connect provider. Create a web application there with this redirect URI:") }),
      h("div", { class: "row", style: "margin-bottom:12px" }, h("code", { text: sso.redirectUri }), copyButton(sso.redirectUri)),
      h(
        "form",
        {
          onsubmit: async (e) => {
            e.preventDefault();
            try {
              await api("PUT", "/sso", {
                enabled: enabled.checked,
                issuer: issuer.value.trim(),
                clientId: clientId.value.trim(),
                ...(clientSecret.value ? { clientSecret: clientSecret.value } : {}),
                allowedDomains: csv(domains.value),
                autoProvisionRole: auto.value || null,
              });
              ssoMsg.replaceChildren(notice(tx("Saved. Sign out and use “Sign in with single sign-on” to try it; your API key keeps working.")));
              clientSecret.value = "";
            } catch (err) {
              ssoMsg.replaceChildren(notice(errorText(err), true));
            }
          },
        },
        field(tx("Issuer URL"), issuer, tx("Its /.well-known/openid-configuration is checked when you save.")),
        h("div", { class: "two" }, field(tx("Client id"), clientId), field(tx("Client secret"), clientSecret)),
        field(tx("Allowed e-mail domains"), domains, tx("Comma separated. Empty allows any domain for invited people.")),
        field(tx("Create accounts on first sign-in"), auto, tx("Off is safest: only people you invite can sign in.")),
        h("label", { class: "check" }, enabled, tx("Enabled")),
        ssoMsg,
        h(
          "div",
          { class: "row" },
          h("button", { class: "btn primary", type: "submit", text: tx("Save") }),
          sso.updatedAt
            ? h("button", { class: "btn danger", type: "button", text: tx("Remove single sign-on"), onclick: async () => { if (!confirm(tx("Remove single sign-on? Console users are signed out; API keys keep working."))) return; await api("DELETE", "/sso"); route(); } })
            : null,
        ),
      ),
    ),
  );
}

// ------------------------------------------------------------------ audit log
async function auditLog(main) {
  const table = h("tbody");
  const more = h("button", { class: "btn", text: tx("Load more"), hidden: true });
  const filter = h("input", { placeholder: tx("Filter: action (widgets, keys.create) or target id"), style: "min-width:320px" });
  let cursor = null;
  const load = async (reset) => {
    if (reset) {
      cursor = null;
      table.replaceChildren();
    }
    const q = filter.value.trim();
    const by = !q ? "" : /^[a-z][a-z-]*(\.[a-z-]+)?$/.test(q) ? `&action=${encodeURIComponent(q)}` : `&targetId=${encodeURIComponent(q)}`;
    const page = await api("GET", `/audit-log?limit=100${by}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    for (const e of page.items) {
      table.append(
        h(
          "tr",
          {},
          h("td", { class: "small", text: fmtDate(e.at) }),
          h("td", {}, h("span", { class: "badge", text: e.action })),
          h("td", { class: "small mono", text: e.target.id ?? "—" }),
          h("td", { class: "small", text: e.actor.name ?? e.actor.id ?? e.actor.type }),
          h("td", { class: "small mono muted", text: e.ip ?? "" }),
          h(
            "td",
            {},
            h("button", {
              class: "btn",
              text: tx("Details"),
              onclick: () => modal(e.action, h("pre", { class: "small mono", style: "white-space:pre-wrap", text: JSON.stringify(e, null, 2) }), { wide: true }),
            }),
          ),
        ),
      );
    }
    cursor = page.nextCursor;
    more.hidden = !cursor;
    if (!table.children.length) table.append(h("tr", {}, h("td", { colspan: 6, class: "muted", text: tx("No entries.") })));
  };
  more.onclick = () => load(false);
  let t = null;
  filter.oninput = () => {
    clearTimeout(t);
    t = setTimeout(() => void load(true).catch((err) => main.prepend(notice(errorText(err), true))), 300);
  };
  main.append(
    h("p", { class: "muted", text: tx("Every change made through the admin API, and every conversation export. Entries cannot be edited or deleted; stream them to your SIEM with the audit.recorded webhook.") }),
    h("div", { class: "row", style: "margin-bottom:12px" }, filter),
    h("div", { class: "card" }, h("table", {}, h("thead", {}, h("tr", {}, [tx("When"), tx("Action"), tx("Target"), tx("By"), tx("IP"), ""].map((x) => h("th", { text: x })))), table), more),
  );
  await load(true);
}

// ------------------------------------------------------------------ evaluations
const pctOf = (x) => (x === null || x === undefined ? "—" : `${Math.round(x * 100)}%`);
const runBadge = (r) =>
  r.status === "completed"
    ? h("span", { class: `badge ${r.passed === r.total ? "ok" : "warn"}`, text: tx("{0}/{1} passed", r.passed, r.total) })
    : h("span", { class: `badge${r.status === "failed" ? " bad" : ""}`, text: r.status === "running" ? tx("running {0}/{1}", r.completed, r.total) : r.status });

async function evals(main) {
  const id = location.hash.split(/[/?]/)[2];
  if (id) return evalSuite(main, id);
  const [suites, assistantsList] = await Promise.all([api("GET", "/evals"), api("GET", "/assistants")]);
  const names = new Map(assistantsList.map((a) => [a.id, a.name]));
  const canWrite = allowed("config:write");
  main.append(
    h("p", { class: "muted", text: tx("Test suites of real questions with what a good answer must contain. Run them after changing instructions, models, knowledge or guardrails to measure quality and catch regressions before visitors do.") }),
    canWrite ? h("div", { class: "row", style: "margin-bottom:12px" }, h("button", { class: "btn primary", text: tx("New suite"), onclick: () => suiteForm(null, assistantsList) })) : "",
    h(
      "div",
      { class: "card" },
      suites.items.length
        ? h(
            "table",
            {},
            h("thead", {}, h("tr", {}, [tx("Suite"), tx("Assistant"), tx("Cases"), tx("Last run"), tx("Score"), ""].map((x) => h("th", { text: x })))),
            h(
              "tbody",
              {},
              suites.items.map((x) =>
                h(
                  "tr",
                  {},
                  h("td", {}, h("strong", { text: x.name }), x.description ? h("div", { class: "small muted", text: x.description }) : null),
                  h("td", { class: "small", text: names.get(x.assistantId) ?? x.assistantId }),
                  h("td", { text: String(x.caseCount) }),
                  h("td", {}, x.lastRun ? runBadge(x.lastRun) : h("span", { class: "muted small", text: "never" }), x.lastRun ? h("div", { class: "small muted", text: fmtDate(x.lastRun.createdAt) }) : null),
                  h("td", { text: pctOf(x.lastRun?.score) }),
                  h("td", { class: "row" }, h("button", { class: "btn", text: tx("Open"), onclick: () => (location.hash = `#/evals/${x.id}`) })),
                ),
              ),
            ),
          )
        : h("p", { class: "muted", text: tx("No suites yet. Start with 10-20 questions visitors really ask (Insights lists them), each with a phrase the answer must contain.") }),
    ),
  );
}

function suiteForm(suite, assistantsList, done = () => route()) {
  const f = {
    name: h("input", { value: suite?.name ?? "", required: true, maxlength: 100 }),
    description: h("input", { value: suite?.description ?? "", maxlength: 1000 }),
    assistantId: h("select", {}, assistantsList.map((a) => h("option", { value: a.id, text: a.name }))),
  };
  if (suite) f.assistantId.value = suite.assistantId;
  const msg = h("div");
  const dlg = modal(
    suite ? tx("Edit suite") : tx("New evaluation suite"),
    h(
      "form",
      {
        onsubmit: async (e) => {
          e.preventDefault();
          try {
            const body = { name: f.name.value.trim(), description: f.description.value.trim(), assistantId: f.assistantId.value };
            const out = await api(suite ? "PATCH" : "POST", suite ? `/evals/${suite.id}` : "/evals", body);
            dlg.close();
            if (suite) done();
            else location.hash = `#/evals/${out.id}`;
          } catch (err) {
            msg.replaceChildren(notice(errorText(err), true));
          }
        },
      },
      field(tx("Name"), f.name),
      field(tx("Description"), f.description),
      field(tx("Assistant"), f.assistantId),
      msg,
      h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit", text: suite ? tx("Save") : tx("Create") })),
    ),
  );
}

function caseForm(suiteId, c, done) {
  const f = {
    question: h("textarea", { value: c?.question ?? "", rows: 2, required: true, maxlength: 4000 }),
    expectedAnswer: h("textarea", { value: c?.expectedAnswer ?? "", rows: 3, placeholder: tx("Optional. A model judge scores the answer against it (1-5).") }),
    mustInclude: h("textarea", { value: (c?.mustInclude ?? []).join("\n"), rows: 2, placeholder: tx("One phrase per line") }),
    mustNotInclude: h("textarea", { value: (c?.mustNotInclude ?? []).join("\n"), rows: 2, placeholder: tx("One phrase per line") }),
    expectedSources: h("textarea", { value: (c?.expectedSources ?? []).join("\n"), rows: 2, placeholder: tx("URL, document id or part of a title, one per line") }),
    expectedOutcome: h("select", {}, h("option", { value: "", text: tx("Not checked") }), ["answer", "refuse", "handoff"].map((x) => h("option", { value: x, text: x }))),
    access: h("input", { value: (c?.access ?? []).join(", "), placeholder: tx("e.g. customers, staff") }),
    tags: h("input", { value: (c?.tags ?? []).join(", ") }),
    history: h("textarea", {
      value: (c?.history ?? []).map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`).join("\n"),
      rows: 3,
      placeholder: tx("Optional, for follow-up questions:\nUser: Do you ship to Canada?\nAssistant: Yes, in 5-7 days."),
    }),
  };
  f.expectedOutcome.value = c?.expectedOutcome ?? "";
  const msg = h("div");
  const dlg = modal(
    c ? tx("Edit case") : tx("Add case"),
    h(
      "form",
      {
        onsubmit: async (e) => {
          e.preventDefault();
          const body = {
            question: f.question.value.trim(),
            expectedAnswer: f.expectedAnswer.value.trim() || null,
            mustInclude: lines(f.mustInclude.value),
            mustNotInclude: lines(f.mustNotInclude.value),
            expectedSources: lines(f.expectedSources.value),
            expectedOutcome: f.expectedOutcome.value || null,
            access: csv(f.access.value),
            tags: csv(f.tags.value),
            history: parseHistory(f.history.value),
          };
          try {
            if (c) await api("PATCH", `/evals/${suiteId}/cases/${c.id}`, body);
            else await api("POST", `/evals/${suiteId}/cases`, { cases: [body] });
            dlg.close();
            done();
          } catch (err) {
            msg.replaceChildren(notice(errorText(err), true));
          }
        },
      },
      field(tx("Earlier conversation"), f.history, tx("Lines starting with User: or Assistant: (continuation lines join the turn above).")),
      field(tx("Question"), f.question),
      field(tx("Reference answer"), f.expectedAnswer),
      h("div", { class: "two" }, field(tx("Must include"), f.mustInclude), field(tx("Must not include"), f.mustNotInclude)),
      h("div", { class: "two" }, field(tx("Must cite"), f.expectedSources), field(tx("Expected behaviour"), f.expectedOutcome, tx("refuse = blocked by a guardrail or refused by the model (a polite “I can only help with…” is an answer); handoff = passed to a person."))),
      h("div", { class: "two" }, field(tx("Visitor access groups"), f.access, tx("Besides public; for restricted knowledge.")), field(tx("Tags"), f.tags)),
      msg,
      h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit", text: c ? tx("Save") : tx("Add") })),
    ),
    { wide: true },
  );
}

/** "User: …" / "Assistant: …" lines into turns; other lines continue the previous turn. */
function parseHistory(text) {
  const turns = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(user|visitor|assistant|ai)\s*:\s*(.*)$/i.exec(line);
    if (m) turns.push({ role: /^(user|visitor)$/i.test(m[1]) ? "user" : "assistant", content: m[2] });
    else if (turns.length && line.trim()) turns[turns.length - 1].content += `\n${line}`;
  }
  return turns.map((t) => ({ ...t, content: t.content.trim() })).filter((t) => t.content);
}

/** Paste JSON (an array), JSON Lines, or plain questions one per line. */
function parseCases(text) {
  const t = text.trim();
  if (!t) return [];
  if (t.startsWith("[")) return JSON.parse(t);
  return t
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (l.startsWith("{") ? JSON.parse(l) : { question: l }));
}

function importCases(suiteId, done) {
  const area = h("textarea", { rows: 12, class: "mono", placeholder: 'How do I reset my password?\n{"question": "Do you ship to Canada?", "mustInclude": ["Canada"], "expectedOutcome": "answer"}' });
  const msg = h("div");
  const dlg = modal(
    tx("Import cases"),
    h(
      "form",
      {
        onsubmit: async (e) => {
          e.preventDefault();
          try {
            const cases = parseCases(area.value);
            if (!cases.length) throw new Error(tx("Nothing to import."));
            await api("POST", `/evals/${suiteId}/cases`, { cases });
            dlg.close();
            done();
          } catch (err) {
            msg.replaceChildren(notice(errorText(err), true));
          }
        },
      },
      h("p", { class: "muted small", text: tx("One question per line, JSON Lines, or a JSON array of cases (fields: question, expectedAnswer, mustInclude, mustNotInclude, expectedSources, expectedOutcome, access, tags). Up to 500 per suite.") }),
      area,
      msg,
      h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit", text: tx("Import") })),
    ),
    { wide: true },
  );
}

/** Ask which suite to add a question to (from Insights). */
async function addToSuite(question) {
  const suites = (await api("GET", "/evals")).items;
  if (!suites.length) {
    location.hash = "#/evals";
    return;
  }
  const select = h("select", {}, suites.map((x) => h("option", { value: x.id, text: x.name })));
  const q = h("textarea", { value: question, rows: 2 });
  const must = h("textarea", { rows: 2, placeholder: tx("One phrase per line (optional)") });
  const msg = h("div");
  const dlg = modal(
    tx("Add to evaluation suite"),
    h(
      "form",
      {
        onsubmit: async (e) => {
          e.preventDefault();
          try {
            await api("POST", `/evals/${select.value}/cases`, { cases: [{ question: q.value.trim(), mustInclude: lines(must.value) }] });
            dlg.close();
          } catch (err) {
            msg.replaceChildren(notice(errorText(err), true));
          }
        },
      },
      field(tx("Suite"), select),
      field(tx("Question"), q),
      field(tx("Must include"), must),
      msg,
      h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit", text: tx("Add") })),
    ),
  );
}

async function evalSuite(main, id) {
  const [suite, cases, runs, assistantsList] = await Promise.all([
    api("GET", `/evals/${id}`),
    api("GET", `/evals/${id}/cases`),
    api("GET", `/evals/${id}/runs`),
    api("GET", "/assistants"),
  ]);
  const names = new Map(assistantsList.map((a) => [a.id, a.name]));
  const canWrite = allowed("config:write");
  const reload = () => route();
  const active = runs.items.find((r) => r.status === "queued" || r.status === "running");
  if (active) pollTimer = setTimeout(reload, 2000);
  main.closest("main").querySelector(".top h1").textContent = suite.name;

  const judge = h("input", { type: "checkbox", checked: true });
  const target = h("select", {}, assistantsList.map((a) => h("option", { value: a.id, text: a.id === suite.assistantId ? tx("{0} (suite default)", a.name) : a.name })));
  target.value = suite.assistantId;
  const version = h("select", {}, h("option", { value: "", text: tx("Live") }));
  const loadVersions = async () => {
    version.replaceChildren(h("option", { value: "", text: tx("Live") }));
    const v = await api("GET", `/assistants/${target.value}/versions`).catch(() => ({ items: [] }));
    version.append(...v.items.slice(1).map((x) => h("option", { value: String(x.version), text: `v${x.version}${x.note ? ` · ${x.note.slice(0, 40)}` : ""}` })));
  };
  target.addEventListener("change", loadVersions);
  if (canWrite) loadVersions();
  const runMsg = h("div");
  const start = async () => {
    try {
      await api("POST", `/evals/${id}/runs`, {
        judge: judge.checked,
        ...(target.value !== suite.assistantId ? { assistantId: target.value } : {}),
        ...(version.value ? { version: Number(version.value) } : {}),
      });
      reload();
    } catch (err) {
      runMsg.replaceChildren(notice(errorText(err), true));
    }
  };
  const expectations = (c) => [
    c.expectedAnswer ? h("span", { class: "badge", text: tx("reference answer") }) : null,
    ...c.mustInclude.map((p) => h("span", { class: "badge ok", text: `+ ${p}` })),
    ...c.mustNotInclude.map((p) => h("span", { class: "badge bad", text: `− ${p}` })),
    ...c.expectedSources.map((p) => h("span", { class: "badge", text: tx("cites {0}", p) })),
    c.expectedOutcome ? h("span", { class: "badge warn", text: c.expectedOutcome }) : null,
    ...c.tags.map((t) => h("span", { class: "badge", text: `#${t}` })),
    c.history?.length ? h("span", { class: "badge", text: tx("follow-up ({0} earlier turns)", c.history.length) }) : null,
  ];
  main.append(
    suite.description ? h("p", { class: "muted", text: suite.description }) : "",
    canWrite
      ? h(
          "div",
          { class: "card" },
          h("h2", { text: tx("Run") }),
          h("div", { class: "row" }, h("label", { class: "check" }, tx("Assistant"), target), h("label", { class: "check" }, tx("Version"), version), h("label", { class: "check" }, judge, tx("Score reference answers with a model judge")), h("button", { class: "btn primary", text: active ? tx("Running…") : tx("Run suite"), disabled: !!active || !cases.items.length, onclick: start }), active ? h("button", { class: "btn danger", text: tx("Cancel"), onclick: async () => { await api("POST", `/eval-runs/${active.id}/cancel`); reload(); } }) : null),
          h("p", { class: "muted small", text: tx("Runs answer every case like a visitor would (no conversations are stored; actions, MCP and page tools never run) and use model tokens. Pick an earlier version to check whether a change helped, or another assistant to compare a changed copy on the same cases.") }),
          runMsg,
        )
      : "",
    h(
      "div",
      { class: "card" },
      h("h2", { text: tx("Runs") }),
      runs.items.length
        ? h(
            "table",
            {},
            h("thead", {}, h("tr", {}, [tx("When"), tx("Assistant"), tx("Result"), tx("Score"), tx("Tokens"), ""].map((x) => h("th", { text: x })))),
            h(
              "tbody",
              {},
              runs.items.map((r) =>
                h(
                  "tr",
                  {},
                  h("td", { class: "small", text: fmtDate(r.createdAt) }, h("div", { class: "muted", text: r.createdBy ?? "" })),
                  h("td", { class: "small", text: `${names.get(r.assistantId) ?? r.assistantId} v${r.assistantVersion}${r.pinnedVersion ? tx(" (saved version)") : ""}` }),
                  h("td", {}, runBadge(r), r.error ? h("div", { class: "small bad", text: r.error }) : null),
                  h("td", { text: pctOf(r.score) }),
                  h("td", { class: "small muted", text: `${r.inputTokens + r.outputTokens}` }),
                  h("td", { class: "row" }, h("button", { class: "btn", text: tx("Results"), onclick: () => evalRunDialog(r.id) })),
                ),
              ),
            ),
          )
        : h("p", { class: "muted", text: tx("No runs yet.") }),
    ),
    h(
      "div",
      { class: "card" },
      h(
        "div",
        { class: "row", style: "justify-content:space-between;margin-bottom:8px" },
        h("h2", { text: tx("Cases ({0})", cases.items.length), style: "margin:0" }),
        canWrite
          ? h(
              "div",
              { class: "row" },
              h("button", { class: "btn primary", text: tx("Add case"), onclick: () => caseForm(id, null, reload) }),
              h("button", { class: "btn", text: tx("Import"), onclick: () => importCases(id, reload) }),
              h("button", { class: "btn", text: tx("Export"), onclick: () => saveJson(`${suite.name}.json`, cases.items.map(({ id: _i, createdAt: _c, updatedAt: _u, ...rest }) => rest)) }),
              h("button", { class: "btn", text: tx("Edit suite"), onclick: () => suiteForm(suite, assistantsList, reload) }),
              h("button", {
                class: "btn danger",
                text: tx("Delete suite"),
                onclick: async () => {
                  if (!confirm(tx("Delete \"{0}\" with its cases and runs?", suite.name))) return;
                  await api("DELETE", `/evals/${id}`);
                  location.hash = "#/evals";
                },
              }),
            )
          : null,
      ),
      cases.items.length
        ? h(
            "table",
            {},
            h(
              "tbody",
              {},
              cases.items.map((c) =>
                h(
                  "tr",
                  {},
                  h("td", {}, h("div", { text: c.question }), h("div", { class: "row", style: "margin-top:4px" }, expectations(c))),
                  canWrite
                    ? h(
                        "td",
                        { class: "row" },
                        h("button", { class: "btn", text: tx("Edit"), onclick: () => caseForm(id, c, reload) }),
                        h("button", { class: "btn danger", text: tx("Delete"), onclick: async () => { await api("DELETE", `/evals/${id}/cases/${c.id}`); reload(); } }),
                      )
                    : null,
                ),
              ),
            ),
          )
        : h("p", { class: "muted", text: tx("No cases yet.") }),
    ),
  );
}

function saveJson(filename, data) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = h("a", { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function evalRunDialog(runId) {
  const run = await api("GET", `/eval-runs/${runId}`);
  const failedFirst = [...run.results].sort((a, b) => Number(a.passed) - Number(b.passed));
  const change = (r) => {
    if (!r.previous) return null;
    if (r.previous.passed && !r.passed) return h("span", { class: "badge bad", text: tx("regression") });
    if (!r.previous.passed && r.passed) return h("span", { class: "badge ok", text: tx("fixed") });
    const d = r.score - r.previous.score;
    return Math.abs(d) >= 0.05 ? h("span", { class: `badge ${d > 0 ? "ok" : "warn"}`, text: tx("{0}{1} pts", d > 0 ? "+" : "", Math.round(d * 100)) }) : null;
  };
  const regressions = run.results.filter((r) => r.previous?.passed && !r.passed).length;
  modal(
    tx("Run {0}", fmtDate(run.createdAt)),
    h(
      "div",
      {},
      h(
        "div",
        { class: "grid", style: "margin-bottom:12px" },
        ...[
          [tx("Passed"), `${run.passed}/${run.total}`],
          [tx("Score"), pctOf(run.score)],
          [tx("Regressions"), run.previousRunId ? String(regressions) : "—"],
          [tx("Tokens"), String(run.inputTokens + run.outputTokens)],
        ].map(([k, v]) => h("div", { class: "card stat" }, h("div", { class: "v", text: v }), h("div", { class: "k", text: k }))),
      ),
      h(
        "table",
        {},
        h(
          "tbody",
          {},
          failedFirst.map((r) =>
            h(
              "tr",
              {},
              h(
                "td",
                {},
                h("div", { class: "row" }, h("span", { class: `badge ${r.passed ? "ok" : "bad"}`, text: r.passed ? "pass" : "fail" }), h("strong", { text: r.question }), change(r)),
                h("div", { class: "small clamp", style: "margin-top:4px", text: r.error ? tx("Error: {0}", r.error) : r.answer }),
                h(
                  "div",
                  { class: "row small", style: "margin-top:4px" },
                  r.checks.map((c) => h("span", { class: `badge ${c.passed ? "ok" : "bad"}`, title: c.detail ?? "", text: `${c.name.replace(/_/g, " ")} ${Math.round(c.score * 100)}%${c.detail && !c.passed ? `: ${c.detail}` : ""}` })),
                  r.guardrail ? h("span", { class: "badge warn", text: tx("guardrail: {0}", r.guardrail) }) : null,
                  r.citations.length ? h("span", { class: "muted", text: tx("cites {0}", r.citations.map((c) => c.title).join(", ")) }) : null,
                ),
              ),
              h("td", { class: "small muted", style: "white-space:nowrap", text: `${pctOf(r.score)} · ${(r.latencyMs / 1000).toFixed(1)}s` }),
            ),
          ),
        ),
      ),
    ),
    { wide: true },
  );
}

// ------------------------------------------------------------------ shell + router
async function route() {
  clearTimeout(pollTimer);
  const name = (location.hash.replace(/^#\//, "") || "overview").split(/[/?]/)[0];
  const view = VIEWS[name] && allowed(VIEWS[name].perm) ? VIEWS[name] : Object.values(VIEWS).find((v) => allowed(v.perm));
  document.querySelectorAll("aside [data-view]").forEach((b) => {
    b.setAttribute("aria-current", b.dataset.view === name ? "page" : "false");
    if (b.dataset.view === name) b.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  });
  const main = document.querySelector("main");
  if (!main || !view) return;
  const content = h("div");
  main.replaceChildren(h("div", { class: "top" }, h("h1", { text: view.title })), content);
  document.title = tx("{0} · embed-assistant", view.title);
  try {
    await view.render(content);
  } catch (err) {
    if (err.status !== 401) content.replaceChildren(notice(errorText(err), true));
  }
}

async function signOut() {
  const key = getKey();
  if (key?.startsWith("ea_cs_")) await api("POST", "/logout").catch(() => {});
  sessionStorage.removeItem(KEY);
  me = null;
  render();
}

function langSelect() {
  return h("select", { class: "lang", "aria-label": tx("Language"), onchange: (e) => setLang(e.target.value) },
    Object.entries(LANGS).map(([v, name]) => h("option", { value: v, text: name, selected: v === LANG })));
}

function render(error) {
  if (!getKey()) {
    app.replaceChildren(loginView(error));
    return;
  }
  if (!me) {
    signedIn().catch((err) => {
      sessionStorage.removeItem(KEY);
      render(errorText(err));
    });
    return;
  }
  const nav = Object.entries(VIEWS)
    .filter(([, v]) => allowed(v.perm))
    .map(([id, v]) => h("button", { "data-view": id, onclick: () => (location.hash = `#/${id}`), text: v.title }));
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
        h("div", { class: "small muted", style: "padding:4px 10px" }, h("div", { text: me.email ?? me.name ?? tx("API key") }), h("span", { class: "badge", text: me.role })),
        h("a", { class: "small", href: "/openapi.json", target: "_blank", text: tx("API reference (OpenAPI)") }),
        h("button", { onclick: signOut, text: tx("Sign out") }),
        langSelect(),
      ),
      h("main"),
    ),
  );
  route();
}

window.addEventListener("hashchange", () => getKey() && me && route());
if (location.hash.startsWith("#/login")) finishSso().then((error) => error !== undefined && render(error || undefined), (err) => render(errorText(err)));
else render();
