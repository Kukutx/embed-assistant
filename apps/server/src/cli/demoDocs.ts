/** Small knowledge base used by `pnpm seed`, so a fresh install can answer questions immediately. */
export const DEMO_DOCS: { slug: string; title: string; content: string }[] = [
  {
    slug: "embedding",
    title: "Embedding the assistant on a website",
    content: `# Embedding the assistant on a website

## The script tag
Add one script tag to any page, in any framework or CMS:

\`<script src="https://YOUR-SERVER/widget/loader.js" data-widget-id="wgt_..." async></script>\`

The loader is tiny. It shows the launcher button right away and downloads the full widget the first time a visitor opens the chat.

## Allowed websites
Every widget has a list of allowed origins, such as https://www.example.com. Requests from other websites are refused. Use * only for testing.

## Options
Optional attributes on the script tag: data-locale (for example zh or it), data-position (bottom-right or bottom-left), data-accent-color, data-open (open on load) and data-launcher="false" to hide the default button and open the chat from your own button.

## JavaScript API
After loading, window.EmbedAssistant offers open(), close(), toggle(), ask(question), setContext({ url, title, attributes }), identify(getUserToken) and on(event, handler).`,
  },
  {
    slug: "identity",
    title: "Signed-in users and private knowledge",
    content: `# Signed-in users and private knowledge

## Anonymous visitors
Without any setup, visitors are anonymous. They only get answers from knowledge marked public, and their chat history stays in their browser profile.

## Signed-in users
To recognise a signed-in user, your backend signs a short JSON Web Token with the widget's identity secret (HS256). Claims: sub (your user id, required), exp (required, at most one hour ahead), and optionally name, email and groups.

Pass a function that returns a fresh token: EmbedAssistant.identify(async () => (await fetch("/my-backend/assistant-token")).text()).

Any language that can sign a JWT works: Node.js, Python, Go, Java, C#, Ruby, Rust and others.

## Access groups
Every knowledge source has access tags. public is visible to everyone, users to any signed-in user, and any other tag only to users whose token lists it in groups. Filtering happens in the database before the AI sees anything, so restricted text can never leak into an answer for the wrong person.`,
  },
  {
    slug: "models",
    title: "Supported AI models",
    content: `# Supported AI models

## Providers
The server talks to Claude through the official Anthropic SDK, to any OpenAI-compatible endpoint (OpenAI, Azure OpenAI, Ollama, vLLM, LiteLLM, LM Studio and others), and has a built-in offline mode that answers by quoting the documentation.

## Aliases and failover
Assistants use a model alias such as standard, fast or private instead of a vendor model name. Each alias lists deployments in order. If the first one is unavailable before the answer starts, the next one takes over automatically. Change models in one configuration file without touching assistants.

## Self-hosting
Everything runs with one Postgres database (with pgvector). No other infrastructure is needed. Point an alias at a local Ollama model to keep all data on your own servers.`,
  },
  {
    slug: "knowledge",
    title: "Adding knowledge",
    content: `# Adding knowledge

## Crawl a website
Create a knowledge source of type url (one page) or sitemap (many pages). The server crawls it in the background and keeps it up to date when you press sync. Pages that disappear are removed.

## Push documents
For content that is not on a public website, create a manual source and push documents with PUT /v1/admin/sources/{id}/documents from any system: a CMS, a ticketing tool, a docs build or a script. Sending the same externalId again replaces the document.

## Search
Answers use hybrid search: keyword search that works in many languages (including Chinese and Japanese) plus vector search when an embeddings model is configured. Every answer cites its sources with numbered links.`,
  },
];
