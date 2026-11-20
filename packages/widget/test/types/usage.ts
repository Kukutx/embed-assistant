// Compiled against dist/embed-assistant.d.ts by `pnpm typecheck` (after build): the published types must stay usable.
window.EmbedAssistantConfig = { widgetId: "wgt_1", mode: "dark", launcher: false };
const api = window.EmbedAssistant;
if (api) {
  api.ask("Where is my order?");
  const off: () => void = api.on("handoff", (detail) => console.log(detail));
  off();
  api.setContext({ attributes: { plan: "pro" } });
  api.identify(() => fetch("/token").then((r) => r.text()));
  api.registerTool({ name: "cart", description: "Read the cart", handler: () => ({ items: 2 }) });
  void api.search("refund", { limit: 3 }).then((hits) => hits[0]?.title.toUpperCase());
}
