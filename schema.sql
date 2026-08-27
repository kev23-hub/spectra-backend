-- Schéma SQLite pour le backend Spectra.
-- Chaque "compte" peut être une personne autiste ou un aidant.
-- Un compte aidant peut être lié à un ou plusieurs comptes "personne"
-- via un code d'invitation à usage unique, et inversement une personne
-- peut avoir plusieurs aidants liés (parents, enseignant, orthophoniste...).

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,          -- uuid
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name  TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL CHECK (role IN ('person','caregiver')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Lien entre un compte "personne" et un compte "aidant".
-- role_label precise le role de l'aidant vis-a-vis de cette personne
-- (parent, enseignant, orthophoniste...), pour affichage seulement.
CREATE TABLE IF NOT EXISTS links (
  id            TEXT PRIMARY KEY,          -- uuid
  person_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  caregiver_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_label    TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(person_id, caregiver_id)
);

-- Codes d'invitation a usage unique. Fonctionnent dans les deux sens : une
-- personne autiste peut inviter un aidant, ou un aidant peut inviter la
-- personne qu'il accompagne -- peu importe qui telecharge l'app en premier.
-- inviter_role memorise le role de celui qui a cree le code, pour verifier
-- que seul le role oppose peut l'utiliser.
CREATE TABLE IF NOT EXISTS invite_codes (
  code          TEXT PRIMARY KEY,          -- code court, ex: "SPEC-7F3K"
  inviter_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  inviter_role  TEXT NOT NULL CHECK (inviter_role IN ('person','caregiver')),
  invitee_email TEXT,                      -- optionnel, pour l'envoi par email
  role_label    TEXT NOT NULL DEFAULT '',
  expires_at    TEXT NOT NULL,
  used_at       TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Stockage cle-valeur qui reproduit la semantique de window.storage
-- utilisee par index.html (storageGet/storageSet) : "personal" (prive au
-- compte) ou "shared" (visible par tous les comptes lies a cette personne).
-- owner_id est toujours l'id du compte "personne" (le pivot autour duquel
-- tourne le foyer), meme quand c'est un aidant qui ecrit une donnee partagee.
CREATE TABLE IF NOT EXISTS kv_store (
  owner_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key           TEXT NOT NULL,
  shared        INTEGER NOT NULL DEFAULT 0,   -- 0 = prive, 1 = partage avec les comptes lies
  value         TEXT NOT NULL,                -- JSON stringifie, comme cote client
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by    TEXT NOT NULL REFERENCES users(id),
  PRIMARY KEY (owner_id, key, shared)
);

-- Abonnements aux notifications push (Web Push), un par appareil/navigateur.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id            TEXT PRIMARY KEY,          -- uuid
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint      TEXT NOT NULL,
  p256dh        TEXT NOT NULL,
  auth          TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(endpoint)
);

CREATE INDEX IF NOT EXISTS idx_links_person ON links(person_id);
CREATE INDEX IF NOT EXISTS idx_links_caregiver ON links(caregiver_id);
CREATE INDEX IF NOT EXISTS idx_kv_owner ON kv_store(owner_id);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);

-- Abonnements payants (Stripe). Un utilisateur peut avoir au plus un
-- abonnement actif ; l'historique des changements de statut est conservé
-- via updated_at plutot que supprime, pour garder une trace.
CREATE TABLE IF NOT EXISTS subscriptions (
  id                    TEXT PRIMARY KEY,          -- uuid
  user_id               TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  stripe_customer_id    TEXT NOT NULL,
  stripe_subscription_id TEXT,
  status                TEXT NOT NULL DEFAULT 'inactive', -- inactive | active | past_due | canceled
  price_id              TEXT,
  current_period_end    TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_customer ON subscriptions(stripe_customer_id);

-- Suivi des e-mails ayant reellement paye via Stripe, INDEPENDAMMENT de tout
-- compte Spectra (le paiement a toujours lieu AVANT la creation du compte,
-- via le lien de paiement Stripe). Alimentee uniquement par le webhook Stripe
-- (jamais par le client, jamais falsifiable depuis le navigateur). C'est cette
-- table que /auth/register consulte pour autoriser ou refuser une inscription.
CREATE TABLE IF NOT EXISTS paid_emails (
  email                 TEXT PRIMARY KEY,
  stripe_customer_id    TEXT,
  stripe_subscription_id TEXT,
  status                TEXT NOT NULL DEFAULT 'active', -- active | past_due | canceled
  current_period_end    TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
