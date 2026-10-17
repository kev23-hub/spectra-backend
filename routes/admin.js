// Routes d'administration. Protegees par un jeton unique, ADMIN_TOKEN.
// Si ADMIN_TOKEN n'est pas defini, ces routes repondent 404 : aucune surface
// d'attaque ouverte par defaut.

const express = require('express');
const backup = require('../backup');
const amazon = require('../amazon');

const router = express.Router();

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

router.use((req, res, next) => {
  if (!ADMIN_TOKEN) return res.status(404).json({ error: 'Route inconnue.' });
  const fourni = req.get('X-Admin-Token') || req.query.token || (req.body && req.body.token) || '';
  // Comparaison a temps constant : evite de deviner le jeton caractere par
  // caractere en mesurant le temps de reponse.
  const a = Buffer.from(String(fourni));
  const b = Buffer.from(ADMIN_TOKEN);
  const ok = a.length === b.length && require('crypto').timingSafeEqual(a, b);
  if (!ok) return res.status(401).json({ error: 'Jeton d\'administration invalide.' });
  next();
});

// GET /admin/etat — coup d'oeil rapide sur l'activite reelle.
router.get('/etat', async (req, res) => {
  const db = require('../db');
  const compte = async (t) => (await db.get(`SELECT count(*)::int AS n FROM ${t}`)).n;
  res.json({
    comptes: await compte('users'),
    liens: await compte('links'),
    abonnesPayants: (await db.get("SELECT count(*)::int AS n FROM paid_emails WHERE status IN ('active','trialing') OR (amazon_status = 'active' AND amazon_period_end > now())")).n,
    abonnesAmazon: (await db.get("SELECT count(*)::int AS n FROM paid_emails WHERE amazon_status = 'active' AND amazon_period_end > now()")).n,
    amazon: { pret: amazon.pret(), mode: amazon.config().mode },
    donneesSynchronisees: await compte('kv_store'),
    notifications: await compte('push_subscriptions'),
    sauvegardeAuto: !!(process.env.GITHUB_TOKEN && process.env.GITHUB_BACKUP_REPO && process.env.BACKUP_PASSPHRASE),
    envoiEmail: process.env.RESEND_API_KEY ? 'resend' : (process.env.SMTP_USER ? 'smtp' : 'aucun'),
  });
});

// GET /admin/backup — telecharge une sauvegarde complete.
// ?chiffre=1 pour obtenir le fichier chiffre avec BACKUP_PASSPHRASE.
router.get('/backup', async (req, res) => {
  const dump = await backup.dumpAll();
  const jour = new Date().toISOString().slice(0, 10);
  if (req.query.chiffre === '1') {
    if (!process.env.BACKUP_PASSPHRASE) {
      return res.status(400).json({ error: 'BACKUP_PASSPHRASE non definie sur le serveur.' });
    }
    res.setHeader('Content-Disposition', `attachment; filename="spectra-${jour}.json.enc"`);
    return res.type('application/json').send(backup.chiffrer(JSON.stringify(dump), process.env.BACKUP_PASSPHRASE));
  }
  res.setHeader('Content-Disposition', `attachment; filename="spectra-${jour}.json"`);
  res.json(dump);
});

// POST /admin/backup/github — declenche un depot immediat sur GitHub.
router.post('/backup/github', async (req, res) => {
  res.json(await backup.pousserSurGithub());
});

// POST /admin/restore — reinjecte une sauvegarde (corps = le fichier JSON).
// A utiliser apres avoir cree une nouvelle base, par exemple parce que
// l'ancienne a expire.
router.post('/restore', express.json({ limit: '50mb' }), async (req, res) => {
  const corps = req.body && req.body.dump ? req.body.dump : req.body;
  const dump = corps && corps.chiffrement
    ? JSON.parse(backup.dechiffrer(corps, process.env.BACKUP_PASSPHRASE))
    : corps;
  const bilan = await backup.restore(dump);
  res.json({ restaure: true, bilan });
});

module.exports = router;
