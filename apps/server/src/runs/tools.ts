import type { ClientToolDef } from "@embed-assistant/protocol";
import { callAction, type ActionCaller, type ActionRow } from "../actions/actions.js";
import type { ToolDef } from "../models/types.js";

/** Result content handed back to the model. */
export interface ToolOutput {
  content: string;
  isError: boolean;
}

export interface RunTool {
  def: ToolDef;
  /** Label shown to the visitor while it runs. */
  title: string;
  kind: "builtin" | "action" | "client" | "mcp";
  /** Ask the visitor before running. */
  confirm: boolean;
  /** Server-side implementation (absent for client tools). */
  run?: (input: Record<string, unknown>, signal: AbortSignal) => Promise<ToolOutput>;
}

export const SEARCH_TOOL = "search_knowledge";
export const HANDOFF_TOOL = "handoff_to_human";

export const searchToolDef: ToolDef = {
  name: SEARCH_TOOL,
  description:
    "Search the knowledge base (documentation, help articles) and return numbered passages you can cite. " +
    "Use it when the sources already provided do not answer the question: try different keywords, synonyms, " +
    "the product's own terms, or look up a related topic. Do not repeat a search with the same query.",
  parameters: {
    type: "object",
    properties: { query: { type: "string", minLength: 2, maxLength: 300, description: "Search terms or a question." } },
    required: ["query"],
    additionalProperties: false,
  },
};

export const handoffToolDef: ToolDef = {
  name: HANDOFF_TOOL,
  description:
    "Hand the conversation over to a human from the team. Use it when the user explicitly asks for a person, " +
    "or when you cannot solve their problem with the available information and tools and a person could. " +
    "The team receives the transcript. Afterwards, tell the user briefly that the team has been notified.",
  parameters: {
    type: "object",
    properties: { reason: { type: "string", maxLength: 500, description: "One sentence: what the user needs help with." } },
    required: ["reason"],
    additionalProperties: false,
  },
};

/** Server-side HTTP action as a tool. */
export function actionTool(
  a: ActionRow,
  o: { key: Buffer; signingSecret: string | null; caller: ActionCaller; allowPrivate: boolean },
): RunTool {
  return {
    def: { name: a.name, description: a.description, parameters: a.parameters },
    title: a.title,
    kind: "action",
    confirm: a.confirm,
    run: async (input) => {
      const r = await callAction(a, input, o);
      return { content: r.output || (r.isError ? "error" : "(no content)"), isError: r.isError };
    },
  };
}

/** Tool registered by the host page; executed in the visitor's browser. */
export function clientTool(t: ClientToolDef): RunTool {
  return {
    def: { name: t.name, description: t.description, parameters: t.parameters },
    title: t.name.replace(/[_-]+/g, " "),
    kind: "client",
    confirm: false,
  };
}

/** Turn whatever the page returned into text for the model. */
export function stringifyOutput(v: unknown, max = 16_000): string {
  let s: string;
  if (v === undefined || v === null) s = "";
  else if (typeof v === "string") s = v;
  else {
    try {
      s = JSON.stringify(v);
    } catch {
      s = String(v);
    }
  }
  return s.length > max ? `${s.slice(0, max)}… (truncated)` : s;
}
