-- The conversation between one account and the language-model assistant: what was said and what the assistant did
-- (or waits for a yes on) as a result, kept so the chat is there again after a reload. Owned by the account, gone
-- with it.
CREATE TABLE assistant_messages (
  id         bigserial PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('user', 'assistant')),
  content    text NOT NULL,
  actions    jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assistant_messages_user_idx ON assistant_messages (user_id, id DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON assistant_messages TO metrion_app;
GRANT USAGE, SELECT ON SEQUENCE assistant_messages_id_seq TO metrion_app;
