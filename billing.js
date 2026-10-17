const express = require('express');
const Stripe = require('stripe');
const { randomUUID, randomBytes } = require('crypto');
const db = require('../db');
const { requireAuth, signManageToken, verifyManageToken } = require('../auth');
const { sendSubscriptionWelcomeEmail, sendCancellationEmail } = require('../email');
const amazon = require('../amazon');

const router = express.Router();

if (!process.env.STRIPE_SECRET_KEY) {
  console.warn('[stripe] STRIPE_SECRET_KEY absente : les routes /billing renverront une erreur.');
}
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

// Statuts consideres comme "acces ouvert". past_due = paiement en echec mais
// Stripe reessaie encore : on laisse l'acces (periode de grace), et on applique
// EXACTEMENT la meme liste partout. Avant, /billing/status acceptait past_due
// mais isEmailPaid non : le client gardait l'application mais ne pouvait plus
// inviter personne ni creer de compte, sans explication.
const ACTIVE_STATUSES = ['active', 'trialing', 'past_due'];

// Une ligne de paid_emails ouvre l'acces si Stripe OU Amazon est actif.
// Utilisee partout a la place de ACTIVE_STATUSES.includes(ligne.status), pour
// qu'un abonne Amazon soit reconnu aussi comme parrain d'invitations, etc.
function ligneActive(ligne) {
  return !!ligne && (ACTIVE_STATUSES.includes(ligne.status) || amazon.actif(ligne));
}

function requireStripe(req, res, next) {
  if (!stripe) return res.status(500).json({ error: 'Stripe n\'est pas configure sur ce serveur (STRIPE_SECRET_KEY manquante).' });
  next();
}

// Regle de l'Appstore Amazon : dans l'application Fire, l'abonnement se vend
// UNIQUEMENT par l'achat integre d'Amazon, jamais par un autre moyen de
// paiement. L'application envoie "SpectraAmazon/x.y.z" dans son User-Agent :
// meme si une page tentait d'ouvrir Stripe, le serveur ne fournirait aucun lien.
function refuserDansAppAmazon(req, res, next) {
  if (amazon.estAppAmazon(req)) {
    return res.status(403).json({
      error: 'Dans l\'application Amazon, l\'abonnement se gere depuis l\'Appstore Amazon.',
      code: 'USE_AMAZON_IAP',
    });
  }
  next();
}

function generateCode() {
  return 'SPEC-' + randomBytes(3).toString('hex').toUpperCase();
}

// Les versions recentes de l'API Stripe ont deplace current_period_end de
// l'abonnement vers ses items. On lit les deux emplacements, sinon les dates
// de fin de periode deviennent silencieusement nulles apres une mise a jour
// de version d'API cote Stripe.
function periodEndOf(subscription) {
  const ts = subscription.current_period_end
    ?? subscription.items?.data?.[0]?.current_period_end;
  return ts ? new Date(ts * 1000).toISOString() : null;
}

// POST /billing/create-checkout-session (auth requise)
router.post('/create-checkout-session', refuserDansAppAmazon, requireAuth, requireStripe, async (req, res) => {
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
    res.status(500).json({ error: 'Erreur lors de la creation de la session de paiement.' });
  }
});

// POST /billing/create-portal-session (auth requise, depuis l'app)
router.post('/create-portal-session', refuserDansAppAmazon, requireAuth, requireStripe, async (req, res) => {
  const sub = await db.get('SELECT * FROM subscriptions WHERE user_id = ?', [req.user.sub]);
  let customerId = sub && sub.stripe_customer_id;
  if (!customerId) {
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
    res.status(500).json({ error: 'Erreur lors de la creation du portail client.' });
  }
});

// GET /billing/manage?token=...  -- lien de RESILIATION envoye par e-mail.
router.get('/manage', requireStripe, async (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(400).send('Lien invalide : jeton manquant.');
  let payload;
  try {
    payload = verifyManageToken(token);
  } catch (e) {
    return res.status(401).send('Ce lien de gestion a expire ou n\'est pas valide.');
  }
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

// GET /billing/status (auth requise) -- consulte par l'app pour verifier l'acces.
router.get('/status', requireAuth, async (req, res) => {
  const sub = await db.get('SELECT status, price_id, current_period_end FROM subscriptions WHERE user_id = ?', [req.user.sub]);
  let status = sub ? sub.status : null;
  let periodEnd = sub ? sub.current_period_end : null;
  // D'ou vient l'acces : 'stripe', 'amazon' ou 'linked' (compte invite).
  let source = status && ACTIVE_STATUSES.includes(status) ? 'stripe' : null;

  const inactive = () => !status || status === 'inactive' || !ACTIVE_STATUSES.includes(status);

  if (inactive()) {
    // isEmailPaid interroge Stripe directement si l'e-mail est inconnu ou si le
    // dernier controle date de plus de 12 h : l'acces ne depend donc plus du webhook.
    await isEmailPaid(req.user.email);
    const paid = await db.get(
      'SELECT status, current_period_end, amazon_status, amazon_period_end, amazon_env FROM paid_emails WHERE email = ?',
      [req.user.email.toLowerCase()]
    );
    if (paid && ACTIVE_STATUSES.includes(paid.status)) {
      status = paid.status; periodEnd = paid.current_period_end; source = 'stripe';
    } else if (paid && amazon.actif(paid)) {
      // Abonnement vendu par l'Appstore Amazon (application Fire).
      status = 'active'; periodEnd = paid.amazon_period_end; source = 'amazon';
    }
  }

  // Compte cree via code d'invitation : l'acces depend du payeur qui l'a invite.
  if (inactive()) {
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
          // Le payeur Amazon n'ouvre peut-etre pas l'application lui-meme : on
          // revérifie son abonnement ici, sinon l'acces des comptes invites
          // s'arreterait a la fin de sa periode meme s'il a ete renouvele.
          await amazon.rafraichir(sponsorEmail.toLowerCase());
          const sponsor = await db.get(
            'SELECT status, amazon_status, amazon_period_end, amazon_env FROM paid_emails WHERE email = ?',
            [sponsorEmail.toLowerCase()]
          );
          if (ligneActive(sponsor)) { status = 'linked'; source = 'linked'; }
        }
      }
    }
  }

  // Filet de securite : un lien avec un compte QUI PAIE ENCORE vaut acces.
  // L'ancienne version accordait l'acces des qu'un lien existait, sans jamais
  // verifier le paiement : les comptes invites gardaient donc l'acces a vie
  // apres la resiliation du payeur.
  if (inactive()) {
    const others = await db.query(`
      SELECT u.email FROM links l
      JOIN users u ON u.id = CASE WHEN l.person_id = ? THEN l.caregiver_id ELSE l.person_id END
      WHERE l.person_id = ? OR l.caregiver_id = ?
    `, [req.user.sub, req.user.sub, req.user.sub]);
    for (const other of others) {
      await amazon.rafraichir(other.email.toLowerCase());
      const sponsor = await db.get(
        'SELECT status, amazon_status, amazon_period_end, amazon_env FROM paid_emails WHERE email = ?',
        [other.email.toLowerCase()]
      );
      if (ligneActive(sponsor)) { status = 'linked'; source = 'linked'; break; }
    }
  }

  const active = ACTIVE_STATUSES.includes(status) || status === 'linked';
  res.json({ status: status || 'inactive', active, currentPeriodEnd: periodEnd, source: active ? source : null });
});

// POST /billing/webhook -- appele par Stripe uniquement.
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

  // Envoie l'e-mail de bienvenue une seule fois par abonne.
  // Le code d'invitation est desormais REUTILISE s'il en existe deja un de
  // valide : sinon, chaque echec d'envoi (Resend mal configure) creait un
  // nouveau code, et ces codes fantomes consommaient le quota d'invitations
  // du payeur jusqu'a le bloquer completement.
  const sendWelcomeOnce = async (email, customerId) => {
    if (!email) return;
    email = email.toLowerCase();
    const row = await db.get('SELECT welcome_sent_at FROM paid_emails WHERE email = ?', [email]);
    if (row && row.welcome_sent_at) return;

    let invite = await db.get(`
      SELECT code, expires_at FROM invite_codes
      WHERE lower(source_email) = ? AND used_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC LIMIT 1
    `, [email]);

    if (!invite) {
      const code = generateCode();
      const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
      await db.run(
        'INSERT INTO invite_codes (code, source_email, role_label, expires_at) VALUES (?, ?, ?, ?)',
        [code, email, '', expiresAt]
      );
      invite = { code, expires_at: expiresAt };
    }

    const result = await sendSubscriptionWelcomeEmail({
      to: email,
      inviteCode: invite.code,
      inviteExpiresAt: invite.expires_at,
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
      console.error('Impossible de recuperer l\'email du client Stripe:', e.message);
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
        const resilie = s.cancel_at_period_end === true || !!s.canceled_at;
        const fields = {
          status: s.status,
          subscriptionId: s.id,
          priceId: s.items?.data?.[0]?.price?.id,
          currentPeriodEnd: periodEndOf(s),
        };
        await upsertPaidEmail(email, s.customer, fields);
        await upsertExistingAccount(s.customer, fields);
        if (!resilie && ['active', 'trialing'].includes(s.status)) await sendWelcomeOnce(email, s.customer);
        break;
      }
      case 'customer.subscription.deleted': {
        const s = event.data.object;
        const email = await getCustomerEmail(s.customer);
        const periodEnd = periodEndOf(s);
        await upsertPaidEmail(email, s.customer, { status: 'canceled', currentPeriodEnd: periodEnd });
        await upsertExistingAccount(s.customer, { status: 'canceled' });
        if (email) await sendCancellationEmail({ to: email, periodEnd });
        break;
      }
      default:
        break;
    }
  } catch (e) {
    // On renvoie 500 pour que Stripe REESSAIE pendant 3 jours. Avant, une
    // coupure d'une seconde de la base suffisait pour qu'un paiement reel ne
    // soit jamais enregistre, sans aucun moyen de le rattraper.
    console.error('Erreur de traitement du webhook:', e);
    return res.status(500).json({ error: 'retry' });
  }

  res.json({ received: true });
}

// ---------------------------------------------------------------------------
// Verification directe aupres de Stripe, en secours du webhook.
//
// POURQUOI : jusqu'ici, tout reposait sur le webhook. S'il n'etait pas cree,
// mal configure, ou si Stripe n'arrivait pas a joindre le serveur endormi, la
// table paid_emails restait vide : les paiements tombaient bien, et AUCUN
// client ne pouvait creer son compte. Rien ne le signalait.
//
// Desormais, si un e-mail est inconnu, le serveur demande directement a Stripe
// si un abonnement existe pour cette adresse. Le webhook devient une optimisation
// et non plus un point de rupture.
//
// Le resultat est memorise avec sa date de controle : on ne réinterroge Stripe
// qu'au plus une fois toutes les 12 heures par client, ce qui permet aussi de
// detecter une resiliation meme sans webhook.
// ---------------------------------------------------------------------------
const DELAI_REVERIFICATION_MS = 12 * 3600 * 1000;

async function syncDepuisStripe(email) {
  if (!stripe || !email) return null;
  email = email.toLowerCase();
  try {
    const clients = await stripe.customers.list({ email, limit: 5 });
    let trouve = null;
    for (const client of clients.data) {
      const abos = await stripe.subscriptions.list({ customer: client.id, status: 'all', limit: 10 });
      const actif = abos.data.find(a => ACTIVE_STATUSES.includes(a.status));
      const abo = actif || abos.data[0];
      if (abo) { trouve = { client, abo, statut: actif ? actif.status : 'canceled' }; if (actif) break; }
    }
    if (!trouve) return null;

    const fin = periodEndOf(trouve.abo);
    await db.run(`
      INSERT INTO paid_emails (email, stripe_customer_id, stripe_subscription_id, status, current_period_end, verified_at)
      VALUES (?, ?, ?, ?, ?, now())
      ON CONFLICT(email) DO UPDATE SET
        stripe_customer_id = EXCLUDED.stripe_customer_id,
        stripe_subscription_id = COALESCE(EXCLUDED.stripe_subscription_id, paid_emails.stripe_subscription_id),
        status = EXCLUDED.status,
        current_period_end = COALESCE(EXCLUDED.current_period_end, paid_emails.current_period_end),
        verified_at = now(),
        updated_at = now()
    `, [email, trouve.client.id, trouve.abo.id, trouve.statut, fin]);
    console.log(`[stripe] Abonnement retrouve directement pour ${email} : ${trouve.statut}`);
    return trouve.statut;
  } catch (e) {
    console.error('[stripe] Verification directe impossible :', e.message);
    return null;
  }
}

// Utilisee par /auth/register, /link/invite et /billing/status.
async function isEmailPaid(email) {
  if (!email) return false;
  email = email.toLowerCase();
  let row = await db.get(
    'SELECT status, verified_at, amazon_user_id, amazon_receipt_id, amazon_status, amazon_period_end, amazon_verified_at, amazon_env FROM paid_emails WHERE email = ?',
    [email]
  );

  if (!row) {
    const statut = await syncDepuisStripe(email);
    return !!statut && ACTIVE_STATUSES.includes(statut);
  }

  // Abonnement Amazon deja enregistre : si le dernier controle date de plus de
  // 12 h, on redemande l'etat a Amazon (renouvellement mensuel, resiliation).
  // Amazon ne renvoie plus le recu d'un abonnement qui continue : sans cette
  // revérification, l'acces se couperait un mois apres l'achat.
  if (amazon.aRafraichir(row)) row = (await amazon.rafraichir(email)) || row;

  // Abonnement Amazon en cours : acces ouvert, sans meme interroger Stripe.
  // Stripe et Amazon sont deux sources independantes (colonnes separees) ; un
  // ancien abonnement Stripe resilie ne doit jamais fermer l'acces d'un abonne
  // Amazon.
  if (amazon.actif(row)) return true;

  const perime = !row.verified_at || (Date.now() - new Date(row.verified_at).getTime()) > DELAI_REVERIFICATION_MS;
  if (stripe && perime) {
    const statut = await syncDepuisStripe(email);
    if (statut) return ACTIVE_STATUSES.includes(statut);
  }
  return ACTIVE_STATUSES.includes(row.status);
}

module.exports = { router, webhookHandler, isEmailPaid, syncDepuisStripe, ACTIVE_STATUSES, ligneActive };
