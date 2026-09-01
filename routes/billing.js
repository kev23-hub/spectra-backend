const express = require('express');
const Stripe = require('stripe');
const jwt = require('jsonwebtoken');
const { randomUUID, randomBytes } = require('crypto');
const db = require('../db');
const { requireAuth } = require('../auth');
const { sendSubscriptionWelcomeEmail, sendCancellationEmail } = require('../email');

const router = express.Router();

if (!process.env.STRIPE_SECRET_KEY) {
  console.warn('[stripe] STRIPE_SECRET_KEY absente : les routes /billing renverront une erreur.');
}
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

function requireStripe(req, res, next) {
  if (!stripe) return res.status(500).json({ error: 'Stripe n\'est pas configuré sur ce serveur (STRIPE_SECRET_KEY manquante).' });
  next();
}

function generateCode() {
  return 'SPEC-' + randomBytes(3).toString('hex').toUpperCase();
}

// Jeton signé permettant d'ouvrir le portail Stripe depuis un lien e-mail,
// sans avoir à se connecter (l'abonné n'a pas forcément encore créé son compte).
function signManageToken(customerId) {
  return jwt.sign({ cus: customerId, kind: 'manage' }, process.env.JWT_SECRET, { expiresIn: '365d' });
}

// POST /billing/create-checkout-session (auth requise)
router.post('/create-checkout-session', requireAuth, requireStripe, async (req, res) => {
  try {
    const user = await db.get('SELECT * FROM users WHERE id = ?', [req.user.sub]);
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable.' });

    let sub = await db.get('SELECT * FROM subscriptions WHERE user_id = ?', [user.id]);
    let customerId = sub && sub.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: user.email, metadata: { userId: user.id } });
      customerId = customer.id;
      await db.run(`
        INSERT INTO subscriptions (id, user_id, stripe_customer_id, status)
        VALUES (?, ?, ?, 'inactive')
        ON CONFLICT(user_id) DO UPDATE SET stripe_customer_id = EXCLUDED.stripe_customer_id
      `, [randomUUID(), user.id, customerId]);
    }

    const priceId = req.body?.priceId || process.env.STRIPE_DEFAULT_PRICE_ID;
    if (!priceId) return res.status(400).json({ error: 'priceId requis (ou STRIPE_DEFAULT_PRICE_ID).' });

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: (process.env.APP_URL || 'http://localhost:3000') + '/app.html?checkout=success',
      cancel_url: (process.env.APP_URL || 'http://localhost:3000') + '/index.html#offre',
      allow_promotion_codes: true,
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur lors de la création de la session de paiement.' });
  }
});

// POST /billing/create-portal-session (auth requise, depuis l'app)
router.post('/create-portal-session', requireAuth, requireStripe, async (req, res) => {
  const sub = await db.get('SELECT * FROM subscriptions WHERE user_id = ?', [req.user.sub]);
  let customerId = sub && sub.stripe_customer_id;
  if (!customerId) {
    // L'abonné a pu payer via le lien Stripe AVANT de créer son compte :
    // on retrouve alors son client Stripe par son e-mail.
    const paid = await db.get('SELECT stripe_customer_id FROM paid_emails WHERE email = ?', [req.user.email.toLowerCase()]);
    customerId = paid && paid.stripe_customer_id;
  }
  if (!customerId) return res.status(404).json({ error: 'Aucun abonnement Stripe pour ce compte.' });
  try {
    const portal = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: (process.env.APP_URL || 'http://localhost:3000') + '/app.html',
    });
    res.json({ url: portal.url });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur lors de la création du portail client.' });
  }
});

// GET /billing/manage?token=...  -- lien de RESILIATION envoyé par e-mail.
// Redirige directement vers le portail Stripe, sans connexion préalable.
router.get('/manage', requireStripe, async (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(400).send('Lien invalide : jeton manquant.');
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (e) {
    return res.status(401).send('Ce lien de gestion a expiré ou n\'est pas valide. Contactez-nous pour obtenir un nouveau lien.');
  }
  if (payload.kind !== 'manage' || !payload.cus) return res.status(400).send('Lien invalide.');
  try {
    const portal = await stripe.billingPortal.sessions.create({
      customer: payload.cus,
      return_url: (process.env.APP_URL || 'http://localhost:3000') + '/index.html',
    });
    res.redirect(303, portal.url);
  } catch (e) {
    console.error(e);
    res.status(500).send('Impossible d\'ouvrir le portail de gestion pour le moment.');
  }
});

// GET /billing/status (auth requise) -- consulté par l'app pour vérifier l'accès.
router.get('/status', requireAuth, async (req, res) => {
  const sub = await db.get('SELECT status, price_id, current_period_end FROM subscriptions WHERE user_id = ?', [req.user.sub]);
  let status = sub ? sub.status : null;
  let periodEnd = sub ? sub.current_period_end : null;

  if (!status || status === 'inactive') {
    const paid = await db.get('SELECT status, current_period_end FROM paid_emails WHERE email = ?', [req.user.email.toLowerCase()]);
    if (paid) { status = paid.status; periodEnd = paid.current_period_end; }
  }
  // Un compte créé via code d'invitation n'a pas d'abonnement propre : son
  // accès dépend de celui qui l'a invité. On remonte donc jusqu'au payeur.
  if (!status || status === 'inactive') {
    const me = await db.get('SELECT invited_via FROM users WHERE id = ?', [req.user.sub]);
    if (me && me.invited_via) {
      const invite = await db.get('SELECT inviter_id, source_email FROM invite_codes WHERE code = ?', [me.invited_via]);
      if (invite) {
        let sponsorEmail = invite.source_email;
        if (!sponsorEmail && invite.inviter_id) {
          const inviter = await db.get('SELECT email FROM users WHERE id = ?', [invite.inviter_id]);
          sponsorEmail = inviter && inviter.email;
        }
        if (sponsorEmail) {
          const sponsor = await db.get('SELECT status FROM paid_emails WHERE email = ?', [sponsorEmail.toLowerCase()]);
          if (sponsor && ['active', 'trialing', 'past_due'].includes(sponsor.status)) status = 'linked';
        }
      }
    }
  }
  // Filet de sécurité : un lien actif avec un autre compte vaut aussi accès.
  if (!status || status === 'inactive') {
    const link = await db.get(
      'SELECT 1 FROM links WHERE person_id = ? OR caregiver_id = ? LIMIT 1',
      [req.user.sub, req.user.sub]
    );
    if (link) status = 'linked';
  }
  const active = ['active', 'trialing', 'past_due', 'linked'].includes(status);
  res.json({ status: status || 'inactive', active, currentPeriodEnd: periodEnd });
});

// POST /billing/webhook -- appelé par Stripe uniquement.
async function webhookHandler(req, res) {
  if (!stripe) return res.status(500).send('Stripe non configuré.');
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Signature webhook invalide:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const upsertExistingAccount = async (customerId, fields) => {
    const sub = await db.get('SELECT * FROM subscriptions WHERE stripe_customer_id = ?', [customerId]);
    if (!sub) return;
    await db.run(`
      UPDATE subscriptions SET
        status = COALESCE(?, status),
        stripe_subscription_id = COALESCE(?, stripe_subscription_id),
        price_id = COALESCE(?, price_id),
        current_period_end = COALESCE(?, current_period_end),
        updated_at = now()
      WHERE stripe_customer_id = ?
    `, [fields.status || null, fields.subscriptionId || null, fields.priceId || null, fields.currentPeriodEnd || null, customerId]);
  };

  const upsertPaidEmail = async (email, customerId, fields) => {
    if (!email) return;
    email = email.toLowerCase();
    await db.run(`
      INSERT INTO paid_emails (email, stripe_customer_id, stripe_subscription_id, status, current_period_end)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(email) DO UPDATE SET
        stripe_customer_id = EXCLUDED.stripe_customer_id,
        stripe_subscription_id = COALESCE(EXCLUDED.stripe_subscription_id, paid_emails.stripe_subscription_id),
        status = EXCLUDED.status,
        current_period_end = COALESCE(EXCLUDED.current_period_end, paid_emails.current_period_end),
        updated_at = now()
    `, [email, customerId, fields.subscriptionId || null, fields.status || 'active', fields.currentPeriodEnd || null]);
  };

  // Envoie l'e-mail de bienvenue (compte + code d'invitation + lien de
  // résiliation) une seule fois par abonné, grâce à welcome_sent_at.
  const sendWelcomeOnce = async (email, customerId) => {
    if (!email) return;
    email = email.toLowerCase();
    const row = await db.get('SELECT welcome_sent_at FROM paid_emails WHERE email = ?', [email]);
    if (row && row.welcome_sent_at) return;

    const code = generateCode();
    const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    await db.run(
      'INSERT INTO invite_codes (code, source_email, role_label, expires_at) VALUES (?, ?, ?, ?)',
      [code, email, '', expiresAt]
    );
    const result = await sendSubscriptionWelcomeEmail({
      to: email,
      inviteCode: code,
      inviteExpiresAt: expiresAt,
      manageToken: signManageToken(customerId),
    });
    if (result.sent) {
      await db.run('UPDATE paid_emails SET welcome_sent_at = now() WHERE email = ?', [email]);
    }
  };

  async function getCustomerEmail(customerId) {
    try {
      const customer = await stripe.customers.retrieve(customerId);
      return customer && !customer.deleted ? customer.email : null;
    } catch (e) {
      console.error('Impossible de récupérer l\'email du client Stripe:', e.message);
      return null;
    }
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const email = session.customer_details?.email || await getCustomerEmail(session.customer);
        await upsertPaidEmail(email, session.customer, { status: 'active', subscriptionId: session.subscription });
        await upsertExistingAccount(session.customer, { status: 'active', subscriptionId: session.subscription });
        await sendWelcomeOnce(email, session.customer);
        break;
      }
      case 'customer.subscription.updated':
      case 'customer.subscription.created': {
        const s = event.data.object;
        const email = await getCustomerEmail(s.customer);
        // Un client qui resilie garde l'acces jusqu'a la fin de la periode
        // deja payee : on conserve donc le statut renvoye par Stripe (souvent
        // encore 'active' avec cancel_at_period_end). C'est l'evenement
        // customer.subscription.deleted, envoye par Stripe a l'echeance, qui
        // coupera l'acces le moment venu.
        const resilie = s.cancel_at_period_end === true || !!s.canceled_at;
        const fields = {
          status: s.status,
          subscriptionId: s.id,
          priceId: s.items?.data?.[0]?.price?.id,
          currentPeriodEnd: s.current_period_end ? new Date(s.current_period_end * 1000).toISOString() : null,
        };
        await upsertPaidEmail(email, s.customer, fields);
        await upsertExistingAccount(s.customer, fields);
        if (!resilie && ['active', 'trialing'].includes(s.status)) await sendWelcomeOnce(email, s.customer);
        break;
      }
      case 'customer.subscription.deleted': {
        const s = event.data.object;
        const email = await getCustomerEmail(s.customer);
        const periodEnd = s.current_period_end ? new Date(s.current_period_end * 1000).toISOString() : null;
        await upsertPaidEmail(email, s.customer, { status: 'canceled', currentPeriodEnd: periodEnd });
        await upsertExistingAccount(s.customer, { status: 'canceled' });
        if (email) await sendCancellationEmail({ to: email, periodEnd });
        break;
      }
      default:
        break;
    }
  } catch (e) {
    console.error('Erreur de traitement du webhook:', e);
  }

  res.json({ received: true });
}

// Utilisée par /auth/register pour vérifier qu'un paiement réel existe.
async function isEmailPaid(email) {
  if (!email) return false;
  const row = await db.get('SELECT status FROM paid_emails WHERE email = ?', [email.toLowerCase()]);
  return !!row && (row.status === 'active' || row.status === 'trialing');
}

module.exports = { router, webhookHandler, isEmailPaid };
