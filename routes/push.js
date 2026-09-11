const express = require('express');
const { randomUUID } = require('crypto');
const webpush = require('web-push');
const db = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

const pushConfigured = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
if (pushConfigured) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:contact@example.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

router.use(requireAuth);

// GET /push/config -- l'application a besoin de la cle publique VAPID pour
// s'abonner. Elle etait jusqu'ici codee en dur cote site, ce qui obligeait a
// redeployer le front a chaque rotation de cle.
router.get('/config', (req, res) => {
  res.json({ enabled: pushConfigured, publicKey: process.env.VAPID_PUBLIC_KEY || null });
});

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

// DELETE /push/subscribe  { endpoint }
router.delete('/subscribe', async (req, res) => {
  const endpoint = req.body?.endpoint;
  if (!endpoint) return res.status(400).json({ error: 'endpoint requis.' });
  await db.run('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', [endpoint, req.user.sub]);
  res.json({ ok: true });
});

async function sendTo(userId, payload) {
  const subs = await db.query('SELECT * FROM push_subscriptions WHERE user_id = ?', [userId]);
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
      // 404/410 = abonnement revoque par le navigateur : on nettoie, sinon la
      // table grossit indefiniment avec des endpoints morts.
      if (e.statusCode === 404 || e.statusCode === 410) {
        await db.run('DELETE FROM push_subscriptions WHERE endpoint = ?', [sub.endpoint]);
      }
    }
  }
  return results;
}

async function notifyLinkedCaregivers(personId, payload) {
  const caregivers = await db.query('SELECT caregiver_id FROM links WHERE person_id = ?', [personId]);
  const results = [];
  for (const { caregiver_id } of caregivers) {
    const r = await sendTo(caregiver_id, payload);
    results.push({ caregiver_id, results: r });
  }
  return results;
}

// POST /push/alert  { title, body, url }
// Cette route manquait : notifyLinkedCaregivers etait exportee mais appelee
// nulle part, donc l'alerte aux aidants n'existait pas cote serveur.
router.post('/alert', async (req, res) => {
  if (!pushConfigured) return res.status(503).json({ error: 'Notifications non configurees sur ce serveur.' });
  if (req.user.role !== 'person') {
    return res.status(403).json({ error: 'Seul un compte "personne" peut alerter ses aidants.' });
  }
  const payload = {
    title: req.body?.title || 'Spectra',
    body: String(req.body?.body || 'Besoin d\'aide.').slice(0, 300),
    url: './app.html',
  };
  const results = await notifyLinkedCaregivers(req.user.sub, payload);
  if (results.length === 0) return res.status(404).json({ error: 'Aucun aidant lie a ce compte.' });
  res.json({ sent: results });
});

// POST /push/test
router.post('/test', async (req, res) => {
  if (!pushConfigured) return res.status(503).json({ error: 'Notifications non configurees sur ce serveur.' });
  const subs = await db.query('SELECT 1 FROM push_subscriptions WHERE user_id = ?', [req.user.sub]);
  if (subs.length === 0) return res.status(404).json({ error: 'Aucun abonnement push pour ce compte.' });
  const results = await sendTo(req.user.sub, {
    title: 'Spectra',
    body: req.body?.body || 'Notification de test.',
    url: './app.html',
  });
  res.json({ results });
});

module.exports = { router, notifyLinkedCaregivers };
