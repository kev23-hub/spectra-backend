const express = require('express');
const { randomUUID } = require('crypto');
const webpush = require('web-push');
const db = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:contact@example.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

router.use(requireAuth);

// POST /push/subscribe  { subscription: PushSubscription JSON du navigateur }
router.post('/subscribe', (req, res) => {
  const sub = req.body?.subscription;
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
    return res.status(400).json({ error: 'Objet subscription invalide.' });
  }
  db.prepare(`
    INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth
  `).run(randomUUID(), req.user.sub, sub.endpoint, sub.keys.p256dh, sub.keys.auth);
  res.status(201).json({ ok: true });
});

// Fonction reutilisable par le reste du serveur (ex: quand une alerte de detresse
// est enregistree via /sync sur la cle "distressAlert", on peut appeler ceci
// pour prevenir les aidants lies -- a brancher explicitement, voir README.md).
async function notifyLinkedCaregivers(personId, payload) {
  const caregivers = db.prepare('SELECT caregiver_id FROM links WHERE person_id = ?').all(personId);
  const results = [];
  for (const { caregiver_id } of caregivers) {
    const subs = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(caregiver_id);
    for (const sub of subs) {
      const pushSubscription = {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth },
      };
      try {
        await webpush.sendNotification(pushSubscription, JSON.stringify(payload));
        results.push({ caregiver_id, ok: true });
      } catch (e) {
        results.push({ caregiver_id, ok: false, error: e.message });
        if (e.statusCode === 410) {
          db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(sub.endpoint);
        }
      }
    }
  }
  return results;
}

// POST /push/test  -- envoie une notification de test a l'utilisateur connecte
router.post('/test', async (req, res) => {
  const subs = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(req.user.sub);
  if (subs.length === 0) return res.status(404).json({ error: 'Aucun abonnement push pour ce compte.' });
  const payload = { title: 'Spectra', body: req.body?.body || 'Notification de test.', url: './index.html' };
  const results = [];
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload)
      );
      results.push({ ok: true });
    } catch (e) {
      results.push({ ok: false, error: e.message });
    }
  }
  res.json({ results });
});

module.exports = { router, notifyLinkedCaregivers };
