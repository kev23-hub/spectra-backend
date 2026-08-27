const express = require('express');
const Stripe = require('stripe');
const { randomUUID } = require('crypto');
const db = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

if (!process.env.STRIPE_SECRET_KEY) {
  console.warn('[stripe] STRIPE_SECRET_KEY absente : les routes /billing renverront une erreur tant qu\'elle ne sera pas definie dans .env');
}
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

function requireStripe(req, res, next) {
  if (!stripe) return res.status(500).json({ error: 'Stripe n\'est pas configure sur ce serveur (STRIPE_SECRET_KEY manquante).' });
  next();
}

// POST /billing/create-checkout-session  (auth requise)
// Cree une session Stripe Checkout pour l'abonnement, et renvoie l'URL
// vers laquelle rediriger l'utilisateur (redirection cote client classique,
// pas d'integration Stripe.js necessaire pour ce flux).
router.post('/create-checkout-session', requireAuth, requireStripe, async (req, res) => {
  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.sub);
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable.' });

    let sub = db.prepare('SELECT * FROM subscriptions WHERE user_id = ?').get(user.id);
    let customerId = sub && sub.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: user.email, metadata: { userId: user.id } });
      customerId = customer.id;
      const id = randomUUID();
      db.prepare(`
        INSERT INTO subscriptions (id, user_id, stripe_customer_id, status)
        VALUES (?, ?, ?, 'inactive')
        ON CONFLICT(user_id) DO UPDATE SET stripe_customer_id = excluded.stripe_customer_id
      `).run(id, user.id, customerId);
    }

    const priceId = req.body?.priceId || process.env.STRIPE_DEFAULT_PRICE_ID;
    if (!priceId) return res.status(400).json({ error: 'priceId requis (ou STRIPE_DEFAULT_PRICE_ID dans .env).' });

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: (process.env.APP_URL || 'http://localhost:3000') + '/billing/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: (process.env.APP_URL || 'http://localhost:3000') + '/billing/cancel',
      allow_promotion_codes: true,
    });

    res.json({ url: session.url });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur lors de la creation de la session de paiement.' });
  }
});

// POST /billing/create-portal-session (auth requise)
// Portail Stripe standard : l'utilisateur y gere/annule son abonnement
// et modifie son moyen de paiement, sans que vous ayez a construire cet ecran.
router.post('/create-portal-session', requireAuth, requireStripe, async (req, res) => {
  const sub = db.prepare('SELECT * FROM subscriptions WHERE user_id = ?').get(req.user.sub);
  if (!sub || !sub.stripe_customer_id) return res.status(404).json({ error: 'Aucun abonnement Stripe pour ce compte.' });
  try {
    const portal = await stripe.billingPortal.sessions.create({
      customer: sub.stripe_customer_id,
      return_url: (process.env.APP_URL || 'http://localhost:3000') + '/account',
    });
    res.json({ url: portal.url });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur lors de la creation du portail client.' });
  }
});

// GET /billing/status (auth requise) -- pour que le frontend sache si le compte est actif
router.get('/status', requireAuth, (req, res) => {
  const sub = db.prepare('SELECT status, price_id, current_period_end FROM subscriptions WHERE user_id = ?').get(req.user.sub);
  res.json({ status: sub ? sub.status : 'inactive', priceId: sub?.price_id, currentPeriodEnd: sub?.current_period_end });
});

// POST /billing/webhook -- appele par Stripe, PAS par le frontend.
// IMPORTANT : cette route doit recevoir le corps BRUT (pas du JSON parse),
// c'est pourquoi server.js la monte AVANT express.json() -- voir server.js.
async function webhookHandler(req, res) {
  if (!stripe) return res.status(500).send('Stripe non configure.');
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Signature webhook invalide:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Met a jour la ligne "subscriptions" d'un compte Spectra DEJA existant,
  // si un tel compte a deja ete cree et lie a ce client Stripe (portail/statut).
  const upsertExistingAccount = (customerId, fields) => {
    const sub = db.prepare('SELECT * FROM subscriptions WHERE stripe_customer_id = ?').get(customerId);
    if (!sub) return;
    db.prepare(`
      UPDATE subscriptions SET
        status = COALESCE(?, status),
        stripe_subscription_id = COALESCE(?, stripe_subscription_id),
        price_id = COALESCE(?, price_id),
        current_period_end = COALESCE(?, current_period_end),
        updated_at = datetime('now')
      WHERE stripe_customer_id = ?
    `).run(fields.status || null, fields.subscriptionId || null, fields.priceId || null, fields.currentPeriodEnd || null, customerId);
  };

  // Met a jour paid_emails, INDEPENDAMMENT de l'existence d'un compte Spectra.
  // C'est la source de verite consultee par /auth/register.
  const upsertPaidEmail = (email, customerId, fields) => {
    if (!email) return;
    email = email.toLowerCase();
    db.prepare(`
      INSERT INTO paid_emails (email, stripe_customer_id, stripe_subscription_id, status, current_period_end)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(email) DO UPDATE SET
        stripe_customer_id = excluded.stripe_customer_id,
        stripe_subscription_id = COALESCE(excluded.stripe_subscription_id, paid_emails.stripe_subscription_id),
        status = excluded.status,
        current_period_end = COALESCE(excluded.current_period_end, paid_emails.current_period_end),
        updated_at = datetime('now')
    `).run(email, customerId, fields.subscriptionId || null, fields.status || 'active', fields.currentPeriodEnd || null);
  };

  async function getCustomerEmail(customerId) {
    try {
      const customer = await stripe.customers.retrieve(customerId);
      return customer && !customer.deleted ? customer.email : null;
    } catch (e) {
      console.error('Impossible de recuperer l\'email du client Stripe:', e.message);
      return null;
    }
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const email = session.customer_details?.email || await getCustomerEmail(session.customer);
        upsertPaidEmail(email, session.customer, { status: 'active', subscriptionId: session.subscription });
        upsertExistingAccount(session.customer, { status: 'active', subscriptionId: session.subscription });
        break;
      }
      case 'customer.subscription.updated':
      case 'customer.subscription.created': {
        const s = event.data.object;
        const email = await getCustomerEmail(s.customer);
        const fields = {
          status: s.status, // active | past_due | canceled | trialing ...
          subscriptionId: s.id,
          priceId: s.items?.data?.[0]?.price?.id,
          currentPeriodEnd: s.current_period_end ? new Date(s.current_period_end * 1000).toISOString() : null,
        };
        upsertPaidEmail(email, s.customer, fields);
        upsertExistingAccount(s.customer, fields);
        break;
      }
      case 'customer.subscription.deleted': {
        const s = event.data.object;
        const email = await getCustomerEmail(s.customer);
        upsertPaidEmail(email, s.customer, { status: 'canceled' });
        upsertExistingAccount(s.customer, { status: 'canceled' });
        break;
      }
      default:
        // Autres evenements ignores volontairement pour ce point de depart.
        break;
    }
  } catch (e) {
    console.error('Erreur de traitement du webhook:', e);
    // On repond quand meme 200 pour eviter que Stripe ne re-essaie indefiniment
    // un evenement qui echoue systematiquement ; l'erreur reste dans les logs.
  }

  res.json({ received: true });
}

// Utilisee par /auth/register pour verifier qu'un paiement reel existe pour cet email.
function isEmailPaid(email) {
  if (!email) return false;
  const row = db.prepare('SELECT status FROM paid_emails WHERE email = ?').get(email.toLowerCase());
  return !!row && (row.status === 'active' || row.status === 'trialing');
}

module.exports = { router, webhookHandler, isEmailPaid };
