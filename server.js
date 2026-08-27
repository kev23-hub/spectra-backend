require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { router: billingRouter, webhookHandler } = require('./routes/billing');

const app = express();
app.use(cors());

// IMPORTANT : le webhook Stripe doit etre monte AVANT express.json(), avec
// express.raw(), car Stripe verifie la signature sur le corps brut de la
// requete. Si ce corps est deja parse en JSON, la verification de signature
// echoue systematiquement -- c'est l'erreur la plus frequente en integration
// Stripe. Ne deplacez pas cette ligne apres app.use(express.json()).
app.post('/billing/webhook', express.raw({ type: 'application/json' }), webhookHandler);

app.use(express.json({ limit: '2mb' }));

app.get('/health', (req, res) => res.json({ ok: true }));

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
app.listen(PORT, () => console.log('Spectra backend en ecoute sur le port ' + PORT));
