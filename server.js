require('dotenv').config();
// Rattrape les erreurs des handlers async d'Express 4. Sans ce require, une
// simple erreur de base de donnees dans une route async devient une
// "unhandled rejection" et Node tue le processus : le serveur redemarre et
// toutes les requetes en cours sont perdues.
require('express-async-errors');

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const db = require('./db');
const { router: billingRouter, webhookHandler } = require('./routes/billing');

const app = express();

// Render place le service derriere un proxy : sans ceci, toutes les requetes
// semblent venir de la meme IP et la limitation de debit devient inutilisable.
app.set('trust proxy', 1);

// CORS restreint aux origines legitimes. La regex /.*\.vercel\.app$/ a ete
// retiree : n'importe qui peut deployer un site sur vercel.app en deux
// minutes, elle annulait donc l'interet de la liste blanche. Ajoutez vos
// domaines de preview dans ALLOWED_ORIGINS si vous en avez besoin.
//
// Les deux domaines de Spectra sont TOUJOURS autorises, en plus de la variable
// ALLOWED_ORIGINS : l'application Fire charge le site depuis
// spectra-nouveau.vercel.app, et si ce domaine manquait dans la variable,
// toutes ses requetes seraient refusees (erreur 403).
const originesSpectra = ['https://spectreautisme2026.vercel.app', 'https://spectra-nouveau.vercel.app'];
const allowedOrigins = [...new Set([
  ...originesSpectra,
  ...(process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
])];
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // curl, applications mobiles, webhooks
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error('Origine non autorisee : ' + origin));
  },
}));

// IMPORTANT : le webhook Stripe doit etre monte AVANT express.json(), avec
// express.raw(), car Stripe verifie la signature sur le corps brut.
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

// Limitation de debit : freine la force brute sur les mots de passe et
// l'enumeration d'adresses e-mail via la reponse 409 de /auth/register.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.DISABLE_RATE_LIMIT === '1',
  message: { error: 'Trop de tentatives. Reessayez dans quelques minutes.' },
});
app.use('/auth/login', authLimiter);
app.use('/auth/register', authLimiter);
app.use('/auth/forgot', authLimiter);
app.use('/auth/reset', authLimiter);

app.use('/admin', require('./routes/admin'));
app.use('/auth', require('./routes/auth'));
app.use('/account', require('./routes/account'));
app.use('/link', require('./routes/link'));
app.use('/sync', require('./routes/sync'));
app.use('/push', require('./routes/push').router);
app.use('/billing', billingRouter);
app.use('/amazon', require('./routes/amazon'));

app.use((req, res) => res.status(404).json({ error: 'Route inconnue.' }));
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  if (/Origine non autorisee/.test(err.message || '')) {
    return res.status(403).json({ error: 'Origine non autorisee.' });
  }
  res.status(500).json({ error: 'Erreur serveur.' });
});

// Un filet de securite de derniere ligne : on journalise au lieu de laisser
// Node terminer brutalement le processus.
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));

const PORT = process.env.PORT || 3000;

// --- Reveil du service (plan gratuit Render) --------------------------------
// Le service s'endort apres 15 minutes sans trafic et met ~50 s a se reveiller.
// On s'auto-appelle pendant les heures ou vos utilisateurs sont actifs : le
// service reste eveille toute la journee, et ne consomme donc qu'une partie du
// quota gratuit de 750 heures par mois (16 h/jour = environ 490 h).
// Reglez la plage avec KEEPALIVE_START / KEEPALIVE_END (heures locales) et le
// fuseau avec TZ (par exemple TZ=Europe/Paris). KEEPALIVE=0 desactive tout.
function planifierReveil() {
  if (process.env.KEEPALIVE === '0') return;
  const cible = (process.env.API_URL || '').replace(/\/$/, '');
  if (!cible) { console.log('[reveil] API_URL absente : maintien en eveil desactive.'); return; }
  const debut = parseInt(process.env.KEEPALIVE_START || '7', 10);
  const fin = parseInt(process.env.KEEPALIVE_END || '23', 10);
  setInterval(() => {
    const h = new Date().getHours();
    const dans = debut <= fin ? (h >= debut && h < fin) : (h >= debut || h < fin);
    if (!dans) return;
    fetch(cible + '/health').catch(() => {});
  }, 10 * 60 * 1000);
  console.log(`[reveil] Maintien en eveil de ${debut} h a ${fin} h (heure du serveur).`);
}

const relecteurs = require('./reviewers');

db.init()
  // Comptes de test des relecteurs Amazon (variables REVIEWER_PASSWORD_1 et _2) :
  // crees AVANT l'ouverture du service, pour exister des la premiere requete.
  .then(() => relecteurs.assurerComptes())
  .then(() => app.listen(PORT, () => {
    console.log('Spectra backend en ecoute sur le port ' + PORT);
    planifierReveil();
    relecteurs.planifier();
    require('./backup').planifierSauvegardes();
  }))
  .catch((e) => {
    console.error('Impossible d\'initialiser la base de donnees :', e.message);
    process.exit(1);
  });
