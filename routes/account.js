// routes/account.js
//
// Suppression de compte. Exigée par le RGPD (droit à l'effacement) ET par
// Google Play : toute application permettant de créer un compte doit offrir
// une suppression DANS l'application et une page web publique de demande.
//
// À monter dans server.js :
//   app.use('/account', require('./routes/account'));
//
// PRÉREQUIS : passer la migration SQL suivante une seule fois, sinon la
// suppression échoue dès qu'un aidant a écrit dans les données partagées
// d'une personne (clé étrangère kv_store.updated_by sans ON DELETE) :
//
//   ALTER TABLE kv_store ALTER COLUMN updated_by DROP NOT NULL;
//   ALTER TABLE kv_store DROP CONSTRAINT IF EXISTS kv_store_updated_by_fkey;
//   ALTER TABLE kv_store ADD CONSTRAINT kv_store_updated_by_fkey
//     FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL;

const express = require('express');
const bcrypt = require('bcryptjs');
const Stripe = require('stripe');
const db = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

router.use(requireAuth);

// GET /account/export
// Le RGPD donne aussi un droit de portabilité : mieux vaut le servir
// automatiquement que de recevoir des demandes par e-mail.
router.get('/export', async (req, res) => {
  const user = await db.get(
    'SELECT id, email, display_name, role, created_at FROM users WHERE id = ?',
    [req.user.sub]
  );
  if (!user) return res.status(404).json({ error: 'Compte introuvable.' });

  const data = await db.query(
    'SELECT key, shared, value, updated_at FROM kv_store WHERE owner_id = ?',
    [req.user.sub]
  );
  const links = await db.query(
    'SELECT id, person_id, caregiver_id, role_label, created_at FROM links WHERE person_id = ? OR caregiver_id = ?',
    [req.user.sub, req.user.sub]
  );

  res.setHeader('Content-Disposition', 'attachment; filename="spectra-mes-donnees.json"');
  res.json({ compte: user, donnees: data, liens: links, exporteLe: new Date().toISOString() });
});

// DELETE /account
// Corps attendu : { password }
//
// Effet : résilie l'abonnement Stripe s'il existe, puis efface le compte.
// ON DELETE CASCADE emporte links, kv_store, push_subscriptions et
// subscriptions. paid_emails et invite_codes sont nettoyés explicitement.
router.delete('/', async (req, res) => {
  const { password } = req.body || {};
  if (!password) {
    return res.status(400).json({ error: 'Mot de passe requis pour confirmer la suppression.' });
  }

  const user = await db.get('SELECT * FROM users WHERE id = ?', [req.user.sub]);
  if (!user) return res.status(404).json({ error: 'Compte introuvable.' });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Mot de passe incorrect.' });

  // 1) Résiliation Stripe. On ne bloque pas la suppression si Stripe échoue :
  //    le compte doit disparaître même en cas d'incident côté paiement.
  if (stripe) {
    try {
      const paid = await db.get(
        'SELECT stripe_subscription_id FROM paid_emails WHERE email = ?',
        [user.email.toLowerCase()]
      );
      const sub = await db.get(
        'SELECT stripe_subscription_id FROM subscriptions WHERE user_id = ?',
        [user.id]
      );
      const subscriptionId = paid?.stripe_subscription_id || sub?.stripe_subscription_id;
      if (subscriptionId) await stripe.subscriptions.cancel(subscriptionId);
    } catch (e) {
      console.error('[account] Résiliation Stripe impossible :', e.message);
    }
  }

  // 2) Effacement.
  await db.transaction(async (t) => {
    await t.run('DELETE FROM invite_codes WHERE inviter_id = ? OR lower(source_email) = lower(?)',
      [user.id, user.email]);
    await t.run('DELETE FROM paid_emails WHERE email = ?', [user.email.toLowerCase()]);
    await t.run('DELETE FROM users WHERE id = ?', [user.id]);
  });

  res.json({
    deleted: true,
    message: "Votre compte et vos données ont été supprimés. L'abonnement associé, s'il existait, a été résilié.",
  });
});

module.exports = router;
