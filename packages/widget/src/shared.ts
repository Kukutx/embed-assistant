/** Contract between the tiny loader and the lazily loaded app bundle. */

declare global {
  const __VERSION__: string;
  const __APP_FILE__: string;
  interface Window {
    EmbedAssistant?: EmbedAssistantApi;
    __embedAssistantMount?: (ctx: MountContext) => AppHandle;
  }
}

export interface PageContextInput {
  url?: string;
  title?: string;
  locale?: string;
  attributes?: Record<string, string>;
}

export type UserTokenProvider = () => string | null | undefined | Promise<string | null | undefined>;

export type EventName = "ready" | "open" | "close" | "message" | "error";
export type Listener = (detail: unknown) => void;

/** Options read from the script tag (data-*) or passed to EmbedAssistant.init(). */
export interface WidgetOptions {
  widgetId: string;
  /** API origin, defaults to the origin the loader was served from. */
  apiBase: string;
  locale?: string | undefined;
  position?: "bottom-right" | "bottom-left" | undefined;
  accentColor?: string | undefined;
  mode?: "light" | "dark" | "auto" | undefined;
  /** false hides the floating button; open the chat from your own UI. */
  launcher: boolean;
  /** Open on load. */
  open: boolean;
  /** Send the current page URL and title with each question. */
  pageContext: boolean;
  /** z-index of the floating UI. */
  zIndex: number;
}

/** Public JavaScript API: `window.EmbedAssistant`. Calls made before the app loads are queued. */
export interface EmbedAssistantApi {
  readonly version: string;
  open(): void;
  close(): void;
  toggle(): void;
  /** Open the chat and ask a question. */
  ask(question: string): void;
  /** Extra context sent with every question (merged with page url/title). */
  setContext(ctx: PageContextInput): void;
  /** Recognise the signed-in user: a function returning a JWT signed by your backend (or null to sign out). */
  identify(provider: UserTokenProvider | null): void;
  on(event: EventName, fn: Listener): () => void;
  /** Remove the widget from the page. */
  destroy(): void;
}

export interface MountContext {
  options: WidgetOptions;
  root: ShadowRoot;
  host: HTMLElement;
  launcher: HTMLButtonElement | null;
  emit(event: EventName, detail?: unknown): void;
  /** State set through the API before the app loaded. */
  initial: { context: PageContextInput; identify: UserTokenProvider | null };
}

export interface AppHandle {
  open(): void;
  close(): void;
  toggle(): void;
  ask(question: string): void;
  setContext(ctx: PageContextInput): void;
  identify(provider: UserTokenProvider | null): void;
  destroy(): void;
  isOpen(): boolean;
}

export const CSS_PREFIX = "ea";
export const DEFAULT_ACCENT = "#2563eb";

/** Readable text color (black/white) on top of a hex background. */
export function contrastText(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return "#ffffff";
  const n = parseInt(m[1]!, 16);
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return L > 0.4 ? "#111111" : "#ffffff";
}

export const CHAT_ICON =
  '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>';
export const CLOSE_ICON =
  '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
