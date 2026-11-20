-- 1.0.12: images visitors attach to a question (screenshots), for vision models.
CREATE TABLE attachments (
  id              text PRIMARY KEY,
  tenant_id       text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  -- Set when a question is sent with it; unattached uploads are purged after a day.
  message_id      text REFERENCES messages(id) ON DELETE CASCADE,
  media_type      text NOT NULL,
  name            text,
  size            integer NOT NULL,
  data            bytea NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attachments_conversation ON attachments (conversation_id, created_at);
CREATE INDEX attachments_message ON attachments (message_id) WHERE message_id IS NOT NULL;
CREATE INDEX attachments_unattached ON attachments (created_at) WHERE message_id IS NULL;

-- Metadata of the attachments on a message ({id, mediaType, name, size}), so listing messages needs no join.
ALTER TABLE messages ADD COLUMN attachments jsonb NOT NULL DEFAULT '[]';
