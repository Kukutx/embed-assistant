# Single-page apps

Load the script once (for example in your root component) and use the global API anywhere. No package or wrapper is needed, so it works with every framework and version.

**TypeScript**: download the declarations your server publishes, `https://assistant.example.com/widget/embed-assistant.d.ts`, into your project (for example `src/types/embed-assistant.d.ts`). `window.EmbedAssistant` and `window.EmbedAssistantConfig` are then fully typed, without the `as any` casts below.

## React

```tsx
import { useEffect } from "react";

export function Assistant({ widgetId, user }: { widgetId: string; user?: { id: string } }) {
  useEffect(() => {
    if (document.querySelector("script[data-embed-assistant-loader]")) return;
    (window as any).EmbedAssistantConfig = { widgetId };
    const s = document.createElement("script");
    s.src = "https://assistant.example.com/widget/loader.js";
    s.async = true;
    s.dataset.embedAssistantLoader = "";
    document.body.appendChild(s);
  }, [widgetId]);

  useEffect(() => {
    const identify = () =>
      (window as any).EmbedAssistant?.identify(user ? () => fetch("/api/assistant-token").then((r) => r.text()) : null);
    if ((window as any).EmbedAssistant) identify();
    else window.addEventListener("embed-assistant:loaded", identify, { once: true });
  }, [user?.id]);

  return null;
}
```

## Vue

```ts
onMounted(() => {
  window.EmbedAssistantConfig = { widgetId: "wgt_…" };
  const s = document.createElement("script");
  s.src = "https://assistant.example.com/widget/loader.js";
  s.async = true;
  document.body.appendChild(s);
});
```

## Route changes

The page URL and title are read when a question is sent, so client-side navigation is picked up automatically. Use `EmbedAssistant.setContext({ attributes: { … } })` for anything else the assistant should know (current product, plan, page section). Context is shown to the model as untrusted data and is never used for authorization.
