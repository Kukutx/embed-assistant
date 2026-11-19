-- 1.0.6: live agent inbox. A person on the team can take over a conversation
-- (mode 'human'); their replies and the visitor's messages stream over
-- per-conversation events.
ALTER TABLE conversations
  ADD COLUMN mode                text NOT NULL DEFAULT 'assistant' CHECK (mode IN ('assistant', 'human')),
  ADD COLUMN assignee_id         text REFERENCES console_users(id) ON DELETE SET NULL,
  ADD COLUMN assignee_name       text,
  ADD COLUMN assigned_at         timestamptz,
  ADD COLUMN handoff_resolved_at timestamptz;
CREATE INDEX conversations_inbox ON conversations (tenant_id, handoff_at DESC) WHERE handoff_at IS NOT NULL;

-- Display name of the person who wrote an assistant-side message (null = the AI assistant).
ALTER TABLE messages ADD COLUMN author_name text;

CREATE TABLE conversation_events (
  id              bigserial PRIMARY KEY,
  conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  type            text NOT NULL,
  data            jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX conversation_events_conversation ON conversation_events (conversation_id, id);
CREATE INDEX conversation_events_created ON conversation_events (created_at);
