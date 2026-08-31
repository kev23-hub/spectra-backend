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

// POST /push/subscribe
router.post('/subscribe', async (req, res) => {
  try {
    const sub = req.body?.subscription;
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
      return res.status(400).json({ error: 'Objet subscription invalide.' });
    }
    await db.run(`
      INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth
    `, [randomUUID(), req.user.sub, sub.endpoint, sub.keys.p256dh, sub.keys.auth]);
    res.status(201).json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur d\'enregistrement de la notification.' });
  }
});

async function notifyLinkedCaregivers(personId, payload) {
  const caregivers = await db.query('SELECT caregiver_id FROM links WHERE person_id = ?', [personId]);
  const results = [];
  for (const { caregiver_id } of caregivers) {
    const subs = await db.query('SELECT * FROM push_subscriptions WHERE user_id = ?', [caregiver_id]);
    for (const sub of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify(payload)
        );
        results.push({ caregiver_id, ok: true });
      } catch (e) {
        results.push({ caregiver_id, ok: false, error: e.message });
        if (e.statusCode === 410) {
          await db.run('DELETE FROM push_subscriptions WHERE endpoint = ?', [sub.endpoint]);
        }
      }
    }
  }
  return results;
}

// POST /push/test
router.post('/test', async (req, res) => {
  const subs = await db.query('SELECT * FROM push_subscriptions WHERE user_id = ?', [req.user.sub]);
  if (subs.length === 0) return res.status(404).json({ error: 'Aucun abonnement push pour ce compte.' });
  const payload = { title: 'Spectra', body: req.body?.body || 'Notification de test.', url: './app.html' };
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
