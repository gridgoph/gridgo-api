export const up = (pgm) => {
  pgm.sql(`CREATE TABLE notification_push_outbox (
    id BIGSERIAL PRIMARY KEY,
    notification_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL REFERENCES device_tokens(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','delivered','suppressed','expired','failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '48 hours',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_code TEXT,
    UNIQUE(notification_id,device_id)
  ); CREATE INDEX notification_push_outbox_due ON notification_push_outbox(next_attempt_at) WHERE status IN ('pending','sending');`);
};
export const down = (pgm) => pgm.dropTable("notification_push_outbox");
