# Pilot on an existing website

This guide adds the assistant to a site that is already live and checks that it helps before you show it to everyone. It takes about an hour, plus 2 to 4 weeks of running.

## 1. Decide what it answers

Pick **one** job, usually questions about one product's help pages or documentation. Write down:

- the pages it should know (a sitemap URL, an `llms.txt`, a docs folder, or files to upload);
- where a visitor goes when the assistant cannot help (support email, ticket form, chat URL);
- 20 to 30 real questions visitors ask today, with the page that answers each. They become the evaluation set.

## 2. Run the server

Any host with Docker and a public HTTPS address works (a small VM with 2 vCPU and 4 GB is plenty for a pilot; see [Capacity](operations.md#capacity)).

```bash
git clone https://github.com/Kukutx/embed-assistant && cd embed-assistant
./scripts/quickstart.sh                 # creates .env with a random SECRET_KEY, starts Postgres and the server
```

Then in `.env`:

| Setting | Value |
| --- | --- |
| `PUBLIC_BASE_URL` | The HTTPS address of the server, for example `https://assistant.example.com` |
| `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` | One model provider (any OpenAI-compatible server works too, see [configuration](configuration.md#models)) |
| `EMBEDDINGS_*` (optional) | Vector search; helps when visitors use different words than the pages |
| `TRUST_PROXY=true` | Only if a reverse proxy you control terminates HTTPS in front of the server |

Run `docker compose up -d` again after changing `.env`. Put the server behind HTTPS (Caddy, nginx, a load balancer) with response buffering off for `/v1/runs/*/events` ([details](operations.md#deploying)). For production, use the published image `ghcr.io/kukutx/embed-assistant:<version>` and a managed Postgres with backups ([backups](operations.md#backups-and-restore)).

## 3. Connect the knowledge

In the console (`/admin`):

1. **Knowledge → Add knowledge**: the sitemap or `llms.txt` of the site, with a re-sync schedule (daily is typical). Upload files for content that is not public.
2. **Knowledge → Test search**: try five of your questions. If the right page is not in the results, the assistant cannot answer it; fix the source (missing pages, pages behind a login, content rendered only by JavaScript) before going on.

## 4. Configure the assistant and the widget

1. **Assistants → New assistant**: attach the source, keep answering only from sources on (`groundedOnly`, the default), write a greeting and up to three suggested questions, set tone and length, and set the handoff target from step 1.
2. **Widgets → New widget**: add the site's exact origin (for example `https://www.example.com`) to the allowed origins and keep a daily token budget so a spike cannot run up the bill.
3. **Evaluations**: add the questions from step 1 and run them. Aim for the expected page cited in at least 80% of cases; read every failure and fix the source or the instructions, then run again.

## 5. Add it to the site

One tag before `</body>`, on every page where it should appear:

```html
<script src="https://assistant.example.com/widget/loader.js" data-widget-id="wgt_…" async></script>
```

Single-page apps set `window.EmbedAssistantConfig` instead ([examples](../examples/)). If the site has a strict Content Security Policy, allow the server's origin in `script-src` and `connect-src`. To start small, show it only on the help pages, or only to signed-in staff with a [user token](identity.md).

Check on the live site: the launcher appears, an answer streams with citations, the handoff link works, and nothing changes in the site's own layout.

## 6. Run it and watch

Every week, in **Insights**:

- **Resolved by the assistant**: the share of conversations closed without a handoff or a thumbs-down. It should rise week over week as you fix the topics below.
- **Topics**: the groups of questions that go worst, with the article to write or fix. Fix the top one or two each week.
- **Searches without results** and rated-down answers in **Conversations**.

Turn on the weekly digest (**Settings**) to get this by webhook.

## 7. Decide

After 2 to 4 weeks, compare the resolution rate, the support tickets on the same topics and the model tokens used (**Overview**, or `GET /v1/admin/usage`). Then widen it (all pages, more sources, actions that do things for the visitor) or stop. Removing it is deleting the script tag.
