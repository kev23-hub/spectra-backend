-- Schéma PostgreSQL pour le backend Spectra.
-- (Migré depuis SQLite : le disque des instances Render gratuites est effacé
--  à chaque redémarrage, ce qui faisait perdre tous les comptes clients.)

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name  TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL CHECK (role IN ('person','caregiver')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS links (
  id            TEXT PRIMARY KEY,
  person_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  caregiver_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_label    TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(person_id, caregiver_id)
);

-- inviter_id est NULLABLE : un code peut être créé automatiquement au moment
-- du paiement Stripe, avant que le moindre compte n'existe (source_email
-- garde alors la trace de l'acheteur).
CREATE TABLE IF NOT EXISTS invite_codes (
  code          TEXT PRIMARY KEY,
  inviter_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
  inviter_role  TEXT CHECK (inviter_role IN ('person','caregiver')),
  source_email  TEXT,
  invitee_email TEXT,
  role_label    TEXT NOT NULL DEFAULT '',
  expires_at    TIMESTAMPTZ NOT NULL,
  used_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kv_store (
  owner_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key           TEXT NOT NULL,
  shared        INTEGER NOT NULL DEFAULT 0,
  value         TEXT NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    TEXT NOT NULL REFERENCES users(id),
  PRIMARY KEY (owner_id, key, shared)
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint      TEXT NOT NULL,
  p256dh        TEXT NOT NULL,
  auth          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(endpoint)
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id                     TEXT PRIMARY KEY,
  user_id                TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  stripe_customer_id     TEXT NOT NULL,
  stripe_subscription_id TEXT,
  status                 TEXT NOT NULL DEFAULT 'inactive',
  price_id               TEXT,
  current_period_end     TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS paid_emails (
  email                  TEXT PRIMARY KEY,
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT,
  status                 TEXT NOT NULL DEFAULT 'active',
  current_period_end     TIMESTAMPTZ,
  welcome_sent_at        TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_links_person ON links(person_id);
CREATE INDEX IF NOT EXISTS idx_links_caregiver ON links(caregiver_id);
CREATE INDEX IF NOT EXISTS idx_kv_owner ON kv_store(owner_id);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_customer ON subscriptions(stripe_customer_id);

-- Mémorise le code d'invitation ayant permis de créer le compte. Sans cela,
-- une personne invitée (qui ne paie pas elle-même et n'a pas toujours de lien
-- immédiat) était considérée comme non abonnée et perdait l'accès au
-- rechargement suivant.
ALTER TABLE users ADD COLUMN IF NOT EXISTS invited_via TEXT;
