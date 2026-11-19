/**
 * embed-assistant loader (a few KB). Embed with:
 *   <script src="https://YOUR-SERVER/widget/loader.js" data-widget-id="wgt_..." async></script>
 * or define `window.EmbedAssistantConfig = { widgetId: "wgt_..." }` before loading it.
 *
 * It renders the launcher immediately and downloads the chat UI only on first use.
 */
import {
  CHAT_ICON,
  DEFAULT_ACCENT,
  contrastText,
  type AppHandle,
  type EmbedAssistantApi,
  type EventName,
  type Listener,
  type PageContextInput,
  type ToolRegistration,
  type UserTokenProvider,
  type WidgetOptions,
} from "./shared.js";

(() => {
  if (window.EmbedAssistant) return; // loaded twice

  const script =
    (document.currentScript as HTMLScriptElement | null) ??
    document.querySelector<HTMLScriptElement>("script[src*='/widget/loader.js']");
  const ds = script?.dataset ?? {};
  const globalCfg = ((window as unknown as { EmbedAssistantConfig?: Record<string, unknown> }).EmbedAssistantConfig ?? {}) as Record<
    string,
    unknown
  >;
  const pick = (key: string, dataKey: string): string | undefined => {
    const v = globalCfg[key] ?? ds[dataKey];
    return v === undefined || v === null ? undefined : String(v);
  };
  const flag = (key: string, dataKey: string, dflt: boolean) => {
    const v = pick(key, dataKey);
    return v === undefined ? dflt : v !== "false" && v !== "0";
  };

  const widgetId = pick("widgetId", "widgetId");
  if (!widgetId) {
    console.warn("[embed-assistant] missing data-widget-id");
    return;
  }
  const scriptOrigin = script?.src ? new URL(script.src, location.href).origin : location.origin;
  const position = pick("position", "position");
  const mode = pick("mode", "mode");
  const options: WidgetOptions = {
    widgetId,
    apiBase: (pick("apiBase", "apiBase") ?? scriptOrigin).replace(/\/$/, ""),
    locale: pick("locale", "locale"),
    position: position === "bottom-left" || position === "bottom-right" ? position : undefined,
    accentColor: /^#[0-9a-f]{6}$/i.test(pick("accentColor", "accentColor") ?? "") ? pick("accentColor", "accentColor") : undefined,
    mode: mode === "light" || mode === "dark" || mode === "auto" ? mode : undefined,
    launcher: flag("launcher", "launcher", true),
    open: flag("open", "open", false),
    pageContext: flag("pageContext", "pageContext", true),
    zIndex: Number(pick("zIndex", "zIndex")) || 2147483000,
    target: pick("target", "target"),
  };
  const assetBase = script?.src ? script.src.replace(/[^/]*$/, "") : `${options.apiBase}/widget/`;

  // ---------------------------------------------------------------- host + launcher
  const host = document.createElement("div");
  host.setAttribute("data-embed-assistant", "");
  host.style.cssText = "all:initial;position:static;";
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  root.appendChild(style);
  const setLauncherStyle = (accent: string, pos: string) => {
    const side = pos === "bottom-left" ? "left" : "right";
    style.textContent = `
      .ea-launcher{position:fixed;${side}:20px;bottom:20px;z-index:${options.zIndex};width:56px;height:56px;border-radius:50%;
        border:0;cursor:pointer;background:${accent};color:${contrastText(accent)};display:grid;place-items:center;
        box-shadow:0 6px 24px rgba(0,0,0,.18),0 2px 6px rgba(0,0,0,.12);transition:transform .15s ease,box-shadow .15s ease;
        -webkit-tap-highlight-color:transparent;padding:0}
      .ea-launcher:hover{transform:scale(1.05)}
      .ea-launcher:focus-visible{outline:3px solid ${accent};outline-offset:3px}
      .ea-launcher[hidden]{display:none}
      @media (prefers-reduced-motion:reduce){.ea-launcher{transition:none}.ea-launcher:hover{transform:none}}
      @media print{.ea-launcher{display:none}}`;
  };
  setLauncherStyle(options.accentColor ?? DEFAULT_ACCENT, options.position ?? "bottom-right");

  let launcher: HTMLButtonElement | null = null;
  // Inline mode: render inside a page element instead of floating.
  let container: Element | null = null;
  if (options.target) {
    try {
      container = document.querySelector(options.target);
    } catch {
      container = null;
    }
    if (container) {
      options.inline = true;
      options.launcher = false;
      host.style.cssText = "all:initial;display:block;width:100%;height:100%;min-height:inherit;";
    } else console.warn(`[embed-assistant] target ${options.target} not found; using the floating button`);
  }
  if (options.launcher) {
    launcher = document.createElement("button");
    launcher.type = "button";
    launcher.className = "ea-launcher";
    launcher.setAttribute("aria-label", "Open chat");
    launcher.setAttribute("aria-expanded", "false");
    launcher.innerHTML = CHAT_ICON;
    launcher.hidden = true; // shown once the widget config confirms this site is allowed
    launcher.addEventListener("click", () => api.toggle());
    launcher.addEventListener("pointerenter", () => void loadApp(), { once: true });
    root.appendChild(launcher);
  }

  // ---------------------------------------------------------------- events + queue
  const listeners = new Map<EventName, Set<Listener>>();
  const emit = (event: EventName, detail?: unknown) => {
    listeners.get(event)?.forEach((fn) => {
      try {
        fn(detail);
      } catch (err) {
        console.error(err);
      }
    });
  };
  const initial: { context: PageContextInput; identify: UserTokenProvider | null } = { context: {}, identify: null };
  const tools = new Map<string, ToolRegistration>();
  let app: AppHandle | null = null;
  let pending: ((a: AppHandle) => void)[] = [];
  let loading: Promise<void> | null = null;

  function loadApp(): Promise<void> {
    loading ??= new Promise<void>((resolve, reject) => {
      if (window.__embedAssistantMount) return resolve();
      const s = document.createElement("script");
      s.src = assetBase + __APP_FILE__;
      s.async = true;
      s.crossOrigin = "anonymous";
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("failed to load chat UI"));
      document.head.appendChild(s);
    })
      .then(() => {
        if (app || !window.__embedAssistantMount) return;
        app = window.__embedAssistantMount({ options, root, host, launcher, emit, initial, tools });
        const queued = pending;
        pending = [];
        queued.forEach((fn) => fn(app!));
      })
      .catch((err: Error) => {
        loading = null;
        emit("error", { code: "load_failed", message: err.message });
      });
    return loading;
  }

  const withApp = (fn: (a: AppHandle) => void) => {
    if (app) return fn(app);
    pending.push(fn);
    void loadApp();
  };

  const api: EmbedAssistantApi = {
    version: __VERSION__,
    open: () => withApp((a) => a.open()),
    close: () => app?.close(),
    toggle: () => withApp((a) => a.toggle()),
    ask: (q) => withApp((a) => a.ask(q)),
    setContext: (ctx) => {
      initial.context = { ...initial.context, ...ctx };
      app?.setContext(ctx);
    },
    identify: (provider) => {
      initial.identify = provider;
      app?.identify(provider);
    },
    on: (event, fn) => {
      let set = listeners.get(event);
      if (!set) listeners.set(event, (set = new Set()));
      set.add(fn);
      return () => set!.delete(fn);
    },
    registerTool: (tool) => {
      if (!tool || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(tool.name) || typeof tool.handler !== "function" || !tool.description) {
        throw new TypeError("[embed-assistant] registerTool needs a valid name, a description and a handler");
      }
      tools.set(tool.name, tool);
      return () => {
        if (tools.get(tool.name) === tool) tools.delete(tool.name);
      };
    },
    unregisterTool: (name) => void tools.delete(name),
    destroy: () => {
      app?.destroy();
      host.remove();
      delete window.EmbedAssistant;
    },
  };
  window.EmbedAssistant = api;

  // ---------------------------------------------------------------- boot
  const boot = () => {
    (container ?? document.body).appendChild(host);
    // Prefetch public config (HTTP-cached) to theme the launcher and confirm the site is allowed.
    fetch(`${options.apiBase}/v1/widgets/${encodeURIComponent(options.widgetId)}/config`, { credentials: "omit" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`config ${res.status}`);
        const cfg = (await res.json()) as { theme: { accentColor: string; position: string } };
        setLauncherStyle(options.accentColor ?? cfg.theme.accentColor, options.position ?? cfg.theme.position);
        if (launcher) launcher.hidden = false;
        emit("ready");
        if (options.open || options.inline) api.open();
      })
      .catch((err: Error) => {
        console.warn("[embed-assistant] widget unavailable on this site:", err.message);
        emit("error", { code: "config_failed", message: err.message });
      });
  };
  if (document.body) boot();
  else document.addEventListener("DOMContentLoaded", boot, { once: true });

  window.dispatchEvent(new CustomEvent("embed-assistant:loaded"));
})();
