require('dotenv').config();
const express = require('express');
const cors = require('cors');
const db = require('./db');
const { router: billingRouter, webhookHandler } = require('./routes/billing');

const app = express();

// CORS restreint aux origines légitimes (au lieu de "tout le monde").
// Ajoutez vos domaines dans ALLOWED_ORIGINS, séparés par des virgules.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'https://spectreautisme2026.vercel.app')
  .split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // curl, apps mobiles, webhooks
    if (allowedOrigins.includes(origin) || /^https:\/\/.*\.vercel\.app$/.test(origin)) return cb(null, true);
    return cb(new Error('Origine non autorisée : ' + origin));
  },
}));

// IMPORTANT : le webhook Stripe doit être monté AVANT express.json(), avec
// express.raw(), car Stripe vérifie la signature sur le corps brut.
app.post('/billing/webhook', express.raw({ type: 'application/json' }), webhookHandler);

app.use(express.json({ limit: '2mb' }));

app.get('/health', async (req, res) => {
  try {
    await db.get('SELECT 1 AS ok');
    res.json({ ok: true, db: 'up' });
  } catch (e) {
    res.status(500).json({ ok: false, db: 'down', error: e.message });
  }
});

app.use('/auth', require('./routes/auth'));
app.use('/link', require('./routes/link'));
app.use('/sync', require('./routes/sync'));
app.use('/push', require('./routes/push').router);
app.use('/billing', billingRouter);

app.use((req, res) => res.status(404).json({ error: 'Route inconnue.' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Erreur serveur.' });
});

const PORT = process.env.PORT || 3000;

// On attend que le schéma soit en place avant d'accepter du trafic.
db.init()
  .then(() => app.listen(PORT, () => console.log('Spectra backend en écoute sur le port ' + PORT)))
  .catch((e) => {
    console.error('Impossible d\'initialiser la base de données :', e.message);
    process.exit(1);
  });
