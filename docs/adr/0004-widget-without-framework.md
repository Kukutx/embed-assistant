# ADR 0004: Widget in plain TypeScript, Shadow DOM, lazy loaded

Status: accepted (1.0.0)

## Context
The widget runs inside other people's pages: any framework, any CSS, sometimes strict performance budgets.

## Decision
No UI framework. A ~5 KB loader renders the launcher and exposes a queued JS API; the UI bundle loads on first interaction. All styles live in a Shadow DOM. Markdown is rendered by building DOM nodes. Types come from the protocol package at compile time only.

## Consequences
No version conflicts with the host's React/Vue/etc., no style leakage, minimal cost for visitors who never open the chat. UI code is a bit more manual than with a framework.
