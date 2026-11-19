# ADR 0003: Model aliases with ordered failover, official SDKs where they exist

Status: accepted (1.0.0)

## Context
The product must not be tied to one AI vendor, and an outage of one provider should not take the assistant down.

## Decision
Assistants reference an alias (`standard`, `fast`, `private`, or any name). An alias is an ordered list of deployments defined in one place (env vars or `models.json`). Claude is called through the official Anthropic SDK; everything else through the de-facto OpenAI-compatible protocol; a built-in extractive mode needs no model at all. The router fails over only before the first token.

## Consequences
Switching vendors is a config change. Answers never mix models. The offline mode keeps the widget useful with zero configuration and during outages.
