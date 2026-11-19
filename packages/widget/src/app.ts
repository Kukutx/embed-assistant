/**
 * The chat UI, loaded lazily by loader.ts. Plain DOM + Shadow DOM: no framework,
 * so it works on any page and never conflicts with the host's own libraries.
 */
import type { Citation, ClientToolDef, Message, PageContext, PublicWidgetConfig, RunEvent } from "@embed-assistant/protocol";
import { ApiError, Client } from "./client.js";
import { stringsFor, type Strings } from "./i18n.js";
import { plainText, renderMarkdown, safeUrl } from "./markdown.js";
import { CHAT_ICON, CLOSE_ICON, contrastText, DEFAULT_ACCENT, type AppHandle, type MountContext, type PageContextInput, type UserTokenProvider } from "./shared.js";
import { STYLES } from "./styles.js";

// ------------------------------------------------------------------ icons
const svg = (body: string, size = 18) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const I = {
  send: svg('<path d="M12 19V5M5 12l7-7 7 7"/>'),
  stop: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor"/></svg>',
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  history: svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>'),
  back: svg('<path d="M15 18l-6-6 6-6"/>'),
  close: svg('<path d="M18 6L6 18M6 6l12 12"/>'),
  expand: svg('<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>'),
  collapse: svg('<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>'),
  copy: svg('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>', 16),
  check: svg('<path d="M20 6L9 17l-5-5"/>', 16),
  up: svg('<path d="M7 10v12M15 5.9 14 10h5.8a2 2 0 0 1 2 2.3l-1.4 8A2 2 0 0 1 18.4 22H7V10l4-8a3 3 0 0 1 4 3.9z"/>', 16),
  down: svg('<path d="M17 14V2M9 18.1 10 14H4.2a2 2 0 0 1-2-2.3l1.4-8A2 2 0 0 1 5.6 2H17v12l-4 8a3 3 0 0 1-4-3.9z"/>', 16),
  trash: svg('<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>', 16),
  arrow: svg('<path d="M5 12h14M13 6l6 6-6 6"/>', 16),
  person: svg('<path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1v-6h3zM3 19a2 2 0 0 0 2 2h1v-6H3z"/>'),
  tool: svg('<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/>', 13),
  ok: svg('<path d="M20 6L9 17l-5-5"/>', 13),
  x: svg('<path d="M18 6L6 18M6 6l12 12"/>', 13),
  spark: svg('<path d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4z"/>', 15),
};

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, string | boolean | number | undefined> = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === false) continue;
    if (k === "class") e.className = String(v);
    else if (k === "html") e.innerHTML = String(v); // only ever used with the static icon strings above
    else if (k === "text") e.textContent = String(v);
    else e.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c) e.append(c);
  return e;
}

interface ToolChip {
  callId: string;
  title: string;
  state: "running" | "waiting" | "done" | "error" | "declined";
}

interface ViewMessage {
  key: string;
  id: string | null;
  /** "notice": a local status line, e.g. after asking for a person. */
  role: "user" | "assistant" | "notice";
  content: string;
  citations: Citation[];
  status: Message["status"];
  feedback: "up" | "down" | null;
  phase: "searching" | "thinking" | null;
  error: string | null;
  /** user text to resend when retrying a failed answer */
  retryText?: string;
  suggestions: string[];
  tools: ToolChip[];
  confirm: { runId: string; callId: string; title: string; input: Record<string, unknown>; busy: boolean } | null;
  handoff: { message: string; url: string | null } | null;
}

const blank = (): Pick<ViewMessage, "suggestions" | "tools" | "confirm" | "handoff"> => ({ suggestions: [], tools: [], confirm: null, handoff: null });

let keySeq = 0;
const newKey = () => `m${++keySeq}`;

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}
const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
};

class App {
  private readonly client: Client;
  private cfg: PublicWidgetConfig | null = null;
  private t: Strings;
  private lang: string;
  private context: PageContextInput;
  private conversationId: string | null;
  private messages: ViewMessage[] = [];
  private running: { runId: string | null; abort: AbortController; vm: ViewMessage; cancelTimer?: number } | null = null;
  private view: "chat" | "history" = "chat";
  private opened = false;
  private expanded = false;
  private built = false;
  private configPromise: Promise<void> | null = null;
  private renderQueued = new Set<ViewMessage>();
  private rafId = 0;
  private mediaDark = window.matchMedia?.("(prefers-color-scheme: dark)");
  private mediaMobile = window.matchMedia?.("(max-width: 640px)");

  // DOM
  private panel!: HTMLDivElement;
  private body!: HTMLDivElement;
  private titleText!: HTMLSpanElement;
  private input!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private footer!: HTMLDivElement;
  private backBtn!: HTMLButtonElement;
  private historyBtn!: HTMLButtonElement;
  private handoffBtn!: HTMLButtonElement;
  private newBtn!: HTMLButtonElement;
  private expandBtn!: HTMLButtonElement;
  private live!: HTMLDivElement;
  private disclaimer!: HTMLParagraphElement;
  private readonly msgEls = new Map<ViewMessage, HTMLElement>();

  constructor(private readonly ctx: MountContext) {
    const o = ctx.options;
    this.client = new Client(o.apiBase, o.widgetId, o.locale ?? navigator.language);
    ({ t: this.t, lang: this.lang } = stringsFor(o.locale, navigator.language));
    this.context = { ...ctx.initial.context };
    if (ctx.initial.identify) this.client.setTokenProvider(ctx.initial.identify);
    this.conversationId = this.client.get("conversation");
  }

  // ---------------------------------------------------------------- public handle
  readonly handle: AppHandle = {
    open: () => this.open(),
    close: () => this.close(),
    toggle: () => (this.opened ? this.close() : this.open()),
    ask: (q) => {
      this.open();
      void this.ready().then(() => this.send(q));
    },
    setContext: (ctx) => {
      this.context = { ...this.context, ...ctx };
    },
    identify: (p) => this.identify(p),
    destroy: () => {
      this.running?.abort.abort();
      this.panel?.remove();
    },
    isOpen: () => this.opened,
  };

  private identify(p: UserTokenProvider | null) {
    const wasUser = this.client.subjectKind === "user";
    this.client.setTokenProvider(p);
    // Switching identity means a different owner: start from a clean slate.
    if (wasUser || p) {
      this.conversationId = null;
      this.client.set("conversation", null);
      if (this.built) this.resetChat();
    }
  }

  private ready(): Promise<void> {
    this.configPromise ??= this.client
      .config()
      .then((cfg) => {
        this.cfg = cfg;
        ({ t: this.t, lang: this.lang } = stringsFor(this.ctx.options.locale, cfg.defaultLocale, navigator.language));
        if (this.built) this.applyConfig();
      })
      .catch((err) => {
        this.configPromise = null;
        throw err;
      });
    return this.configPromise;
  }

  // ---------------------------------------------------------------- open / close
  private open() {
    if (!this.built) this.build();
    if (this.opened) return;
    this.opened = true;
    this.panel.classList.add("ea-open");
    this.panel.setAttribute("aria-hidden", "false");
    this.syncLauncher();
    this.ctx.emit("open");
    this.ready()
      .then(async () => {
        if (this.conversationId && this.messages.length === 0) await this.loadConversation(this.conversationId);
        else if (!this.messages.length && this.view === "chat") this.renderChat();
      })
      .catch((err) => this.showBanner(this.errorText(err)));
    // On phones, focusing would pop the keyboard over the greeting; let the user tap the input.
    if (this.ctx.options.inline) {
      /* never steal focus from the page on load */
    } else if (!this.mediaMobile?.matches) requestAnimationFrame(() => this.input.focus({ preventScroll: true }));
    else requestAnimationFrame(() => this.panel.querySelector<HTMLButtonElement>("[data-role=close]")?.focus({ preventScroll: true }));
  }

  private close() {
    if (!this.opened || this.ctx.options.inline) return;
    this.opened = false;
    this.panel.classList.remove("ea-open");
    this.panel.setAttribute("aria-hidden", "true");
    this.syncLauncher();
    this.ctx.emit("close");
    if (this.panel.contains(this.ctx.root.activeElement)) this.ctx.launcher?.focus({ preventScroll: true });
  }

  private syncLauncher() {
    const l = this.ctx.launcher;
    if (!l) return;
    l.setAttribute("aria-expanded", String(this.opened));
    l.setAttribute("aria-label", this.opened ? this.t.closeChat : this.t.openChat);
    l.innerHTML = this.opened ? CLOSE_ICON : CHAT_ICON;
    // On phones the panel is full-screen with its own close button.
    l.style.display = this.opened && this.mediaMobile?.matches ? "none" : "";
  }

  // ---------------------------------------------------------------- DOM construction
  private build() {
    this.built = true;
    const style = h("style");
    style.textContent = STYLES;
    this.ctx.root.appendChild(style);

    this.titleText = h("span", { text: "" });
    this.backBtn = h("button", { class: "ea-icon-btn", type: "button", html: I.back, hidden: true });
    this.historyBtn = h("button", { class: "ea-icon-btn", type: "button", html: I.history });
    this.handoffBtn = h("button", { class: "ea-icon-btn", type: "button", html: I.person, hidden: true });
    this.newBtn = h("button", { class: "ea-icon-btn", type: "button", html: I.plus });
    this.expandBtn = h("button", { class: "ea-icon-btn ea-expand", type: "button", html: I.expand });
    const closeBtn = h("button", { class: "ea-icon-btn", type: "button", html: I.close });
    closeBtn.dataset.role = "close";

    this.body = h("div", { class: "ea-body", role: "log", "aria-live": "off", tabindex: "-1" });
    this.input = h("textarea", { class: "ea-input", rows: "1", maxlength: "4000" });
    this.sendBtn = h("button", { class: "ea-send", type: "button", html: I.send, disabled: true });
    this.disclaimer = h("p", { class: "ea-disclaimer" });
    this.footer = h("div", { class: "ea-footer" }, h("div", { class: "ea-composer" }, this.input, this.sendBtn), this.disclaimer);
    this.live = h("div", { class: "ea-sr", "aria-live": "polite", "aria-atomic": "true" });

    this.panel = h(
      "div",
      { class: "ea-panel", role: "dialog", "aria-hidden": "true" },
      h(
        "div",
        { class: "ea-header" },
        this.backBtn,
        h("div", { class: "ea-title" }, h("div", { class: "ea-avatar", html: I.spark }), this.titleText),
        this.handoffBtn,
        this.historyBtn,
        this.newBtn,
        this.expandBtn,
        closeBtn,
      ),
      this.body,
      this.footer,
      this.live,
    );
    this.ctx.root.appendChild(this.panel);
    if (this.ctx.options.inline) {
      // Part of the page: no dialog semantics, no close or expand.
      this.panel.classList.add("ea-inline");
      this.panel.setAttribute("role", "region");
      closeBtn.hidden = true;
      this.expandBtn.hidden = true;
    }

    // events
    closeBtn.addEventListener("click", () => this.close());
    this.newBtn.addEventListener("click", () => this.newChat());
    this.historyBtn.addEventListener("click", () => void this.showHistory());
    this.handoffBtn.addEventListener("click", () => void this.requestHandoff());
    this.backBtn.addEventListener("click", () => this.showChat());
    this.expandBtn.addEventListener("click", () => {
      this.expanded = !this.expanded;
      this.panel.classList.toggle("ea-expanded", this.expanded);
      this.applyLabels();
    });
    this.sendBtn.addEventListener("click", () => (this.running ? void this.stop() : this.submit()));
    this.input.addEventListener("input", () => this.onInput());
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        if (!this.running) this.submit();
      }
    });
    this.panel.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !this.ctx.options.inline) {
        e.stopPropagation();
        this.close();
      } else if (e.key === "Tab" && this.mediaMobile?.matches && !this.ctx.options.inline) this.trapFocus(e);
    });
    this.mediaDark?.addEventListener?.("change", () => this.applyTheme());
    this.mediaMobile?.addEventListener?.("change", () => this.syncLauncher());

    this.applyConfig();
    this.renderChat();
  }

  private trapFocus(e: KeyboardEvent) {
    const focusables = [...this.panel.querySelectorAll<HTMLElement>("button:not([disabled]):not([hidden]),textarea,a[href]")].filter(
      (el) => el.offsetParent !== null,
    );
    if (!focusables.length) return;
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    const active = this.ctx.root.activeElement;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  private applyConfig() {
    const cfg = this.cfg;
    const o = this.ctx.options;
    const position = o.position ?? cfg?.theme.position ?? "bottom-right";
    this.panel.classList.toggle("ea-left", position === "bottom-left");
    this.panel.style.zIndex = String(o.zIndex);
    this.panel.style.setProperty("--ea-radius", `${cfg?.theme.radius ?? 16}px`);
    this.titleText.textContent = cfg?.assistant.name ?? "";
    this.disclaimer.textContent = cfg?.assistant.disclaimer ?? "";
    this.disclaimer.hidden = !cfg?.assistant.disclaimer;
    this.historyBtn.hidden = cfg ? !cfg.features.history : true;
    this.handoffBtn.hidden = !cfg?.handoff?.enabled;
    this.panel.lang = this.lang;
    this.applyTheme();
    this.applyLabels();
  }

  private applyTheme() {
    const o = this.ctx.options;
    const mode = o.mode ?? this.cfg?.theme.mode ?? "auto";
    const dark = mode === "dark" || (mode === "auto" && !!this.mediaDark?.matches);
    this.panel.classList.toggle("ea-dark", dark);
    const accent = o.accentColor ?? this.cfg?.theme.accentColor ?? DEFAULT_ACCENT;
    const bg = dark ? "#17181b" : "#ffffff";
    this.panel.style.setProperty("--ea-accent", accent);
    this.panel.style.setProperty("--ea-accent-text", contrastText(accent));
    // Links use the accent only when it stays readable on the background.
    this.panel.style.setProperty("--ea-accent-link", contrast(accent, bg) >= 3 ? accent : dark ? "#9ec5ff" : "#1d4ed8");
  }

  private applyLabels() {
    const t = this.t;
    this.panel.setAttribute("aria-label", this.cfg?.assistant.name ?? t.poweredBy);
    const label = (b: HTMLButtonElement, text: string) => {
      b.setAttribute("aria-label", text);
      b.title = text;
    };
    label(this.backBtn, t.back);
    label(this.historyBtn, t.history);
    label(this.handoffBtn, this.cfg?.handoff?.label || t.talkToHuman);
    label(this.newBtn, t.newChat);
    label(this.expandBtn, this.expanded ? t.collapse : t.expand);
    this.expandBtn.innerHTML = this.expanded ? I.collapse : I.expand;
    label(this.panel.querySelector<HTMLButtonElement>("[data-role=close]")!, t.closeChat);
    this.input.placeholder = this.cfg?.assistant.placeholder || t.placeholder;
    this.input.setAttribute("aria-label", this.input.placeholder);
    this.syncSendButton();
    this.syncLauncher();
  }

  // ---------------------------------------------------------------- views
  private renderChat() {
    this.view = "chat";
    this.backBtn.hidden = true;
    this.footer.hidden = false;
    this.body.replaceChildren();
    this.msgEls.clear();
    if (this.messages.length === 0) this.body.appendChild(this.welcome());
    else for (const vm of this.messages) this.body.appendChild(this.messageEl(vm));
    this.scrollToEnd(true);
  }

  private welcome(): HTMLElement {
    const cfg = this.cfg;
    const box = h("div", { class: "ea-welcome" }, h("h2", { text: cfg?.assistant.greeting ?? "" }));
    const sugg = cfg?.assistant.suggestions ?? [];
    if (sugg.length) {
      const list = h("div", { class: "ea-suggestions" });
      for (const s of sugg) {
        const b = h("button", { class: "ea-suggestion", type: "button" }, h("span", { text: s }));
        b.insertAdjacentHTML("beforeend", I.arrow);
        b.addEventListener("click", () => this.send(s));
        list.appendChild(b);
      }
      box.appendChild(list);
    }
    return box;
  }

  private showBanner(text: string) {
    if (!this.built) return;
    this.body.querySelector(".ea-banner")?.remove();
    this.body.prepend(h("div", { class: "ea-banner", role: "status", text }));
  }

  private showChat() {
    this.renderChat();
    this.input.focus();
  }

  private async showHistory() {
    this.view = "history";
    this.backBtn.hidden = false;
    this.footer.hidden = true;
    const list = h("div", { class: "ea-history" });
    this.body.replaceChildren(h("div", { class: "ea-status" }, h("span", { class: "ea-dots", html: "<i></i><i></i><i></i>" })));
    try {
      const page = await this.client.listConversations();
      if (this.view !== "history") return;
      if (!page.items.length) list.appendChild(h("div", { class: "ea-empty", text: this.t.noConversations }));
      for (const conv of page.items) {
        const open = h(
          "button",
          { class: "ea-history-open", type: "button" },
          h("span", { text: conv.title || this.t.untitled }),
          h("small", { text: new Date(conv.updatedAt).toLocaleString(this.lang, { dateStyle: "medium", timeStyle: "short" }) }),
        );
        open.addEventListener("click", () => void this.loadConversation(conv.id));
        const del = h("button", { class: "ea-icon-btn", type: "button", html: I.trash, "aria-label": this.t.deleteConversation, title: this.t.deleteConversation });
        const row = h("div", { class: "ea-history-item" }, open, del);
        del.addEventListener("click", async () => {
          try {
            await this.client.deleteConversation(conv.id);
            row.remove();
            if (this.conversationId === conv.id) this.resetChat(false);
          } catch (err) {
            this.showBanner(this.errorText(err));
          }
        });
        list.appendChild(row);
      }
      this.body.replaceChildren(list);
      list.querySelector<HTMLButtonElement>("button")?.focus();
    } catch (err) {
      this.body.replaceChildren();
      this.showBanner(this.errorText(err));
    }
  }

  private async loadConversation(id: string) {
    if (this.running) return;
    try {
      const page = await this.client.listMessages(id);
      this.setConversation(id);
      this.messages = page.items.map((m) => this.fromMessage(m));
      // An answer still streaming elsewhere (e.g. after a reload) shows as interrupted; refresh to see the final text.
      this.renderChat();
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        this.resetChat(false);
        if (this.view === "history") void this.showHistory();
      } else this.showBanner(this.errorText(err));
    }
  }

  private fromMessage(m: Message): ViewMessage {
    return {
      key: newKey(),
      id: m.id,
      role: m.role,
      content: m.content,
      citations: m.citations,
      status: m.status,
      feedback: m.feedback,
      phase: null,
      error: null,
      ...blank(),
      suggestions: m.suggestions ?? [],
    };
  }

  private setConversation(id: string | null) {
    this.conversationId = id;
    this.client.set("conversation", id);
  }

  private resetChat(focus = true) {
    this.running?.abort.abort();
    this.running = null;
    this.setConversation(null);
    this.messages = [];
    if (this.view === "chat") this.renderChat();
    this.syncSendButton();
    if (focus && this.view === "chat") this.input.focus();
  }

  private newChat() {
    if (this.running) void this.stop();
    this.view = "chat";
    this.resetChat();
  }

  // ---------------------------------------------------------------- messages
  private messageEl(vm: ViewMessage): HTMLElement {
    const wrap = h("div", { class: `ea-msg ea-msg-${vm.role}` });
    this.fillMessage(wrap, vm);
    this.msgEls.set(vm, wrap);
    return wrap;
  }

  private fillMessage(wrap: HTMLElement, vm: ViewMessage) {
    wrap.replaceChildren();
    if (vm.role === "user") {
      wrap.appendChild(h("div", { class: "ea-bubble", text: vm.content }));
      return;
    }
    if (vm.role === "notice") {
      if (vm.handoff) wrap.appendChild(this.handoffBox(vm.handoff));
      return;
    }
    const t = this.t;
    const streaming = vm.status === "streaming";
    if (vm.tools.length) {
      const list = h("div", { class: "ea-tools" });
      for (const tc of vm.tools) {
        const icon =
          tc.state === "running" ? h("span", { class: "ea-spin" }) : h("span", { html: tc.state === "error" || tc.state === "declined" ? I.x : tc.state === "waiting" ? I.tool : I.ok });
        const label = tc.state === "declined" ? `${tc.title} · ${t.declined}` : tc.title;
        list.appendChild(h("span", { class: `ea-tool${tc.state === "error" ? " ea-tool-error" : ""}` }, icon, h("span", { text: label })));
      }
      wrap.appendChild(list);
    }
    if (vm.confirm) wrap.appendChild(this.confirmCard(vm));
    const busyTool = vm.tools.some((x) => x.state === "running" || x.state === "waiting");
    const content = h("div", { class: `ea-content${streaming && vm.content && !vm.phase && !busyTool ? " ea-caret" : ""}` });
    if (vm.content) {
      const byIndex = new Map(vm.citations.map((c) => [c.index, c]));
      content.appendChild(
        renderMarkdown(vm.content, {
          citation: (n) => this.citationChip(n, byIndex.get(n), wrap),
        }),
      );
    }
    if (streaming && vm.phase && !busyTool) {
      content.appendChild(
        h("div", { class: "ea-status" }, h("span", { class: "ea-dots", html: "<i></i><i></i><i></i>" }), h("span", { text: vm.phase === "searching" ? t.searching : t.thinking })),
      );
    }
    wrap.appendChild(content);

    if (vm.status === "cancelled") wrap.appendChild(h("div", { class: "ea-note", text: t.stopped }));
    if (vm.error) {
      const err = h("div", { class: "ea-error", role: "alert" }, h("span", { text: vm.error }));
      if (vm.retryText) {
        const retry = h("button", { class: "ea-link-btn", type: "button", text: t.retry });
        retry.addEventListener("click", () => {
          const text = vm.retryText!;
          this.messages = this.messages.filter((m) => m !== vm);
          this.msgEls.get(vm)?.remove();
          void this.send(text, true);
        });
        err.appendChild(retry);
      }
      wrap.appendChild(err);
    }

    if (!streaming && vm.citations.length && this.cfg?.features.sources !== false) {
      const list = h("div", { class: "ea-sources" }, h("div", { class: "ea-sources-label", text: t.sources }));
      for (const c of vm.citations) {
        const inner = [h("b", { text: String(c.index) }), h("span", { text: c.title })];
        const href = c.url ? safeUrl(c.url) : null;
        const item = href
          ? h("a", { class: "ea-source", href, target: "_blank", rel: "noopener noreferrer", title: c.snippet }, ...inner)
          : h("div", { class: "ea-source", title: c.snippet }, ...inner);
        item.dataset.index = String(c.index);
        list.appendChild(item);
      }
      wrap.appendChild(list);
    }

    if (vm.handoff) wrap.appendChild(this.handoffBox(vm.handoff));
    if (vm.status === "complete" && vm.content) wrap.appendChild(this.actions(vm));
    if (vm.status === "complete" && vm.suggestions.length && !this.running && this.messages.at(-1) === vm) {
      const box = h("div", { class: "ea-followups" }, h("div", { class: "ea-followups-label", text: t.related }));
      for (const q of vm.suggestions) {
        const b = h("button", { class: "ea-followup", type: "button", text: q });
        b.addEventListener("click", () => void this.send(q));
        box.appendChild(b);
      }
      wrap.appendChild(box);
    }
  }

  private handoffBox(ho: { message: string; url: string | null }): HTMLElement {
    const box = h("div", { class: "ea-handoff", role: "status" }, h("span", { text: ho.message }));
    const href = ho.url ? safeUrl(ho.url) : null;
    if (href) box.appendChild(h("a", { href, target: "_blank", rel: "noopener noreferrer", text: href.replace(/^https?:\/\//, "").replace(/\/$/, "") }));
    return box;
  }

  private confirmCard(vm: ViewMessage): HTMLElement {
    const c = vm.confirm!;
    const t = this.t;
    const dl = h("dl");
    for (const [k, v] of Object.entries(c.input).slice(0, 10)) {
      const text = typeof v === "string" ? v : JSON.stringify(v);
      dl.append(h("dt", { text: k }), h("dd", { text: text.length > 200 ? `${text.slice(0, 200)}…` : text }));
    }
    const allow = h("button", { class: "ea-btn ea-btn-primary", type: "button", text: t.allow, disabled: c.busy });
    const deny = h("button", { class: "ea-btn", type: "button", text: t.deny, disabled: c.busy });
    const decide = async (approved: boolean) => {
      c.busy = true;
      this.update(vm);
      try {
        await this.client.toolResult(c.runId, { callId: c.callId, approved });
        const chip = vm.tools.find((x) => x.callId === c.callId);
        if (chip) chip.state = approved ? "running" : "declined";
        vm.confirm = null;
        this.announce(approved ? t.approved : t.declined);
      } catch (err) {
        c.busy = false;
        this.showBanner(this.errorText(err));
      }
      this.update(vm);
    };
    allow.addEventListener("click", () => void decide(true));
    deny.addEventListener("click", () => void decide(false));
    return h(
      "div",
      { class: "ea-confirm", role: "group", "aria-label": t.approvalNeeded },
      h("p", { text: t.approvalNeeded }),
      h("b", { text: c.title }),
      dl.childElementCount ? dl : null,
      h("div", { class: "ea-confirm-row" }, allow, deny),
    );
  }

  private citationChip(n: number, c: Citation | undefined, wrap: HTMLElement): Node | null {
    if (this.cfg?.features.sources === false) return document.createTextNode("");
    const label = c ? `${n}: ${c.title}` : String(n);
    const href = c?.url ? safeUrl(c.url) : null;
    if (href) {
      return h("a", { class: "ea-cite", href, target: "_blank", rel: "noopener noreferrer", title: label, "aria-label": label, text: String(n) });
    }
    const b = h("button", { class: "ea-cite", type: "button", title: label, "aria-label": label, text: String(n) });
    b.addEventListener("click", () => {
      const target = wrap.querySelector<HTMLElement>(`.ea-source[data-index="${n}"]`);
      if (!target) return;
      target.scrollIntoView({ block: "nearest" });
      target.classList.add("ea-flash");
      setTimeout(() => target.classList.remove("ea-flash"), 1200);
    });
    return b;
  }

  private actions(vm: ViewMessage): HTMLElement {
    const t = this.t;
    const row = h("div", { class: "ea-actions" });
    const copy = h("button", { class: "ea-icon-btn", type: "button", html: I.copy, "aria-label": t.copy, title: t.copy });
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(plainText(vm.content));
        copy.innerHTML = I.check;
        copy.title = t.copied;
        this.announce(t.copied);
        setTimeout(() => {
          copy.innerHTML = I.copy;
          copy.title = t.copy;
        }, 1500);
      } catch {
        /* clipboard blocked by the host page's permissions policy */
      }
    });
    row.appendChild(copy);
    if (this.cfg?.features.feedback !== false && vm.id) {
      for (const rating of ["up", "down"] as const) {
        const text = rating === "up" ? t.helpful : t.notHelpful;
        const b = h("button", {
          class: "ea-icon-btn",
          type: "button",
          html: rating === "up" ? I.up : I.down,
          "aria-label": text,
          title: text,
          "aria-pressed": String(vm.feedback === rating),
        });
        b.addEventListener("click", async () => {
          if (vm.feedback === rating) return;
          const prev = vm.feedback;
          vm.feedback = rating;
          this.update(vm);
          try {
            await this.client.feedback(vm.id!, rating);
            this.announce(t.thanks);
          } catch {
            vm.feedback = prev;
            this.update(vm);
          }
        });
        row.appendChild(b);
      }
    }
    return row;
  }

  /** Re-render one message, batched per animation frame (streaming deltas arrive fast). */
  private update(vm: ViewMessage) {
    this.renderQueued.add(vm);
    if (this.rafId) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = 0;
      const stick = this.nearBottom();
      for (const m of this.renderQueued) {
        const el = this.msgEls.get(m);
        if (el) this.fillMessage(el, m);
      }
      this.renderQueued.clear();
      if (stick) this.scrollToEnd();
    });
  }

  private append(vm: ViewMessage) {
    const prev = this.messages.at(-1);
    this.messages.push(vm);
    if (prev?.suggestions.length) this.update(prev);
    if (this.view !== "chat") return;
    this.body.querySelector(".ea-welcome")?.remove();
    this.body.appendChild(this.messageEl(vm));
    this.scrollToEnd(true);
  }

  private nearBottom(): boolean {
    return this.body.scrollHeight - this.body.scrollTop - this.body.clientHeight < 80;
  }

  private scrollToEnd(force = false) {
    if (force || this.nearBottom()) this.body.scrollTop = this.body.scrollHeight;
  }

  private announce(text: string) {
    this.live.textContent = "";
    setTimeout(() => (this.live.textContent = text), 50);
  }

  // ---------------------------------------------------------------- composer
  private onInput() {
    this.input.style.height = "auto";
    this.input.style.height = `${Math.min(this.input.scrollHeight, 150)}px`;
    this.syncSendButton();
  }

  private syncSendButton() {
    const busy = !!this.running;
    this.sendBtn.innerHTML = busy ? I.stop : I.send;
    this.sendBtn.disabled = !busy && !this.input.value.trim();
    const label = busy ? this.t.stop : this.t.send;
    this.sendBtn.setAttribute("aria-label", label);
    this.sendBtn.title = label;
  }

  private submit() {
    const text = this.input.value.trim();
    if (!text || this.running) return;
    this.input.value = "";
    this.onInput();
    void this.send(text);
  }

  private pageContext(): PageContext | undefined {
    const auto: PageContextInput = this.ctx.options.pageContext ? { url: location.href.split("#")[0], title: document.title } : {};
    const merged: PageContextInput = { ...auto, ...this.context, locale: this.context.locale ?? navigator.language };
    const clip = (s: string | undefined, n: number) => (s ? s.slice(0, n) : undefined);
    const ctx: PageContext = {};
    if (merged.url) ctx.url = clip(merged.url, 2048);
    if (merged.title) ctx.title = clip(merged.title, 300);
    if (merged.locale) ctx.locale = clip(merged.locale, 35);
    if (merged.attributes) {
      ctx.attributes = Object.fromEntries(
        Object.entries(merged.attributes)
          .slice(0, 20)
          .map(([k, v]) => [k.slice(0, 64), String(v).slice(0, 500)]),
      );
    }
    return Object.keys(ctx).length ? ctx : undefined;
  }

  private async send(text: string, isRetry = false) {
    if (this.running) return;
    if (this.view !== "chat") this.renderChat();
    const content = text.slice(0, 4000);
    const user: ViewMessage = { key: newKey(), id: null, role: "user", content, citations: [], status: "complete", feedback: null, phase: null, error: null, ...blank() };
    if (!isRetry || this.messages.at(-1)?.content !== content) this.append(user);
    const vm: ViewMessage = { key: newKey(), id: null, role: "assistant", content: "", citations: [], status: "streaming", feedback: null, phase: "searching", error: null, ...blank() };
    this.append(vm);
    const abort = new AbortController();
    this.running = { runId: null, abort, vm };
    this.syncSendButton();

    try {
      await this.ready();
      let conversationId = this.conversationId;
      if (!conversationId) {
        conversationId = (await this.client.createConversation()).id;
        this.setConversation(conversationId);
      }
      const key = this.client.newIdempotencyKey();
      let created;
      try {
        created = await this.client.createRun(conversationId, content, this.pageContext(), key, this.toolDefs());
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 404)) throw err;
        // Conversation was deleted elsewhere: start a new one transparently.
        conversationId = (await this.client.createConversation()).id;
        this.setConversation(conversationId);
        created = await this.client.createRun(conversationId, content, this.pageContext(), key, this.toolDefs());
      }
      if (created.userMessage.content !== user.content) {
        // The server masked personal data: show what was actually stored.
        user.content = created.userMessage.content;
        this.update(user);
      }
      user.id = created.userMessage.id;
      this.running.runId = created.run.id;
      await this.client.streamRun(created.run.id, (e) => this.onEvent(vm, e), abort.signal);
      if (abort.signal.aborted && vm.status === "streaming") vm.status = "cancelled";
    } catch (err) {
      vm.status = "failed";
      vm.phase = null;
      vm.error = this.errorText(err);
      vm.retryText = content;
      this.ctx.emit("error", { code: err instanceof ApiError ? err.code : "unknown", message: vm.error });
    } finally {
      if (this.running?.cancelTimer) clearTimeout(this.running.cancelTimer);
      if (this.running?.vm === vm) this.running = null;
      if (vm.status === "streaming") vm.status = "failed";
      this.update(vm);
      this.syncSendButton();
    }
  }

  private onEvent(vm: ViewMessage, e: RunEvent) {
    switch (e.type) {
      case "retrieval.completed":
        vm.phase = "thinking";
        break;
      case "message.started":
        vm.id = e.data.messageId;
        break;
      case "message.delta":
        vm.phase = null;
        vm.content += e.data.text;
        break;
      case "message.completed": {
        const m = e.data.message;
        Object.assign(vm, { id: m.id, content: m.content, citations: m.citations, status: m.status, phase: null });
        break;
      }
      case "run.completed":
        if (vm.status === "streaming") vm.status = "complete";
        this.announce(`${this.t.answerReady}. ${plainText(vm.content)}`);
        this.ctx.emit("message", { conversationId: this.conversationId, messageId: vm.id, content: vm.content, citations: vm.citations });
        break;
      case "run.failed":
        vm.status = "failed";
        vm.phase = null;
        vm.error = e.data.message;
        vm.retryText = this.precedingUserText(vm);
        break;
      case "run.cancelled":
        vm.status = "cancelled";
        vm.phase = null;
        vm.confirm = null;
        break;
      case "tool.started":
        vm.tools.push({ callId: e.data.callId, title: e.data.title, state: "running" });
        this.ctx.emit("tool", { name: e.data.name, title: e.data.title, state: "started" });
        break;
      case "tool.completed": {
        const chip = vm.tools.find((x) => x.callId === e.data.callId);
        if (chip && chip.state !== "declined") chip.state = e.data.isError ? "error" : "done";
        vm.phase = "thinking";
        this.ctx.emit("tool", { name: e.data.name, state: e.data.isError ? "failed" : "completed" });
        break;
      }
      case "tool.input_required":
        if (vm.tools.some((x) => x.callId === e.data.callId)) break; // replayed after a reconnect
        if (e.data.kind === "client") {
          vm.tools.push({ callId: e.data.callId, title: this.ctx.tools.get(e.data.name)?.description.split(/[.\n]/)[0]?.slice(0, 60) || e.data.title, state: "running" });
          void this.runPageTool(e.runId, e.data.callId, e.data.name, e.data.input);
        } else {
          vm.tools.push({ callId: e.data.callId, title: e.data.title, state: "waiting" });
          vm.confirm = { runId: e.runId, callId: e.data.callId, title: e.data.title, input: e.data.input, busy: false };
          this.announce(`${this.t.approvalNeeded} ${e.data.title}`);
        }
        break;
      case "message.suggestions":
        vm.suggestions = e.data.suggestions.slice(0, 4);
        break;
      case "handoff.requested":
        vm.handoff = { message: e.data.message, url: e.data.url };
        this.ctx.emit("handoff", { conversationId: this.conversationId, trigger: "assistant", ...vm.handoff });
        break;
    }
    this.update(vm);
  }

  /** Definitions of the page's registered tools, sent with each question. */
  private toolDefs(): ClientToolDef[] | undefined {
    const defs = [...this.ctx.tools.values()].slice(0, 20).map((tool) => ({
      name: tool.name,
      description: String(tool.description).slice(0, 1024),
      parameters: tool.parameters ?? { type: "object", properties: {} },
    }));
    return defs.length ? defs : undefined;
  }

  private async runPageTool(runId: string, callId: string, name: string, input: Record<string, unknown>) {
    const tool = this.ctx.tools.get(name);
    let body: { callId: string; output: unknown; isError?: boolean };
    if (!tool) body = { callId, output: `The tool "${name}" is not available on this page.`, isError: true };
    else {
      try {
        let timer = 0;
        const output = await Promise.race([
          Promise.resolve().then(() => tool.handler(input)),
          new Promise((_, reject) => (timer = window.setTimeout(() => reject(new Error("timed out")), 60_000))),
        ]).finally(() => clearTimeout(timer));
        body = { callId, output: output === undefined ? null : JSON.parse(JSON.stringify(output)) };
      } catch (err) {
        body = { callId, output: err instanceof Error ? err.message : String(err), isError: true };
      }
    }
    try {
      await this.client.toolResult(runId, body);
    } catch (err) {
      console.warn("[embed-assistant] could not send tool result", err);
    }
  }

  private async requestHandoff() {
    if (this.handoffBtn.disabled) return;
    this.handoffBtn.disabled = true;
    try {
      await this.ready();
      if (this.view !== "chat") this.renderChat();
      let conversationId = this.conversationId;
      if (!conversationId) {
        conversationId = (await this.client.createConversation()).id;
        this.setConversation(conversationId);
      }
      const r = await this.client.handoff(conversationId);
      const notice: ViewMessage = {
        key: newKey(), id: null, role: "notice", content: "", citations: [], status: "complete", feedback: null, phase: null, error: null,
        ...blank(), handoff: { message: r.message, url: r.url },
      };
      this.append(notice);
      this.announce(r.message);
      this.ctx.emit("handoff", { conversationId, trigger: "visitor", message: r.message, url: r.url });
    } catch (err) {
      this.showBanner(err instanceof ApiError && err.code === "rate_limited" ? this.errorText(err) : this.t.handoffFailed);
    } finally {
      this.handoffBtn.disabled = false;
    }
  }

  private precedingUserText(vm: ViewMessage): string | undefined {
    const i = this.messages.indexOf(vm);
    for (let j = i - 1; j >= 0; j--) if (this.messages[j]!.role === "user") return this.messages[j]!.content;
    return undefined;
  }

  private async stop() {
    const r = this.running;
    if (!r) return;
    if (r.runId) {
      // Ask the server to stop; the stream then ends with run.cancelled. Fall back to a local abort.
      r.cancelTimer = window.setTimeout(() => r.abort.abort(), 4000);
      try {
        await this.client.cancelRun(r.runId);
      } catch {
        r.abort.abort();
      }
    } else r.abort.abort();
  }

  private errorText(err: unknown): string {
    const t = this.t;
    if (err instanceof ApiError) {
      if (err.status === 0) return t.errorNetwork;
      if (err.code === "rate_limited") return t.errorRateLimited;
      if (err.code === "budget_exceeded" || err.code === "model_unavailable") return t.errorBudget;
      if (err.code === "origin_not_allowed") return t.errorUnavailable;
      if (err.code === "conflict") return err.message;
    }
    return t.errorGeneric;
  }
}

window.__embedAssistantMount = (ctx) => new App(ctx).handle;
