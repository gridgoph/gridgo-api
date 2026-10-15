export const up = pgm => pgm.sql(`
  CREATE TABLE web_push_vapid (
    singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
    public_key TEXT NOT NULL,
    private_key TEXT NOT NULL,
    subject TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE web_push_subscriptions (
    id TEXT PRIMARY KEY,
    endpoint TEXT NOT NULL UNIQUE CHECK (length(endpoint) <= 2048),
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    app_role TEXT NOT NULL DEFAULT 'supplier' CHECK (app_role = 'supplier'),
    user_agent TEXT NOT NULL DEFAULT '' CHECK (length(user_agent) <= 512),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_success_at TIMESTAMPTZ,
    last_failure_at TIMESTAMPTZ,
    last_failure_code TEXT
  );
  CREATE INDEX web_push_subscriptions_user ON web_push_subscriptions(user_id);
  ALTER TABLE notification_push_outbox ALTER COLUMN device_id DROP NOT NULL;
  ALTER TABLE notification_push_outbox ADD COLUMN web_subscription_id TEXT REFERENCES web_push_subscriptions(id) ON DELETE CASCADE;
  ALTER TABLE notification_push_outbox ADD CONSTRAINT push_outbox_one_destination CHECK (num_nonnulls(device_id, web_subscription_id) = 1);
  ALTER TABLE notification_push_outbox ADD CONSTRAINT push_outbox_web_unique UNIQUE(notification_id, web_subscription_id);
`);
export const down = pgm => pgm.sql(`
  DELETE FROM notification_push_outbox WHERE web_subscription_id IS NOT NULL;
  ALTER TABLE notification_push_outbox DROP CONSTRAINT push_outbox_one_destination;
  ALTER TABLE notification_push_outbox DROP COLUMN web_subscription_id;
  ALTER TABLE notification_push_outbox ALTER COLUMN device_id SET NOT NULL;
  DROP TABLE web_push_subscriptions;
  DROP TABLE web_push_vapid;
`);
