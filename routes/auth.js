const express = require('express');
const bcrypt = require('bcryptjs');
const { randomUUID } = require('crypto');
const db = require('../db');
const {
  signToken, requireAuth,
  signResetToken, verifyResetToken, peekSubject,
} = require('../auth');
const { sendPasswordResetEmail } = require('../email');

const router = express.Router();

// POST /auth/register  { email, password, displayName, role, inviteCode, amazon }
//
// Preuve de paiement acceptee, dans cet ordre :
//   1. l'e-mail a un abonnement Stripe actif (achat sur le site) ;
//   2. `amazon` : { userId, receiptIds } -- achat integre de l'Appstore Amazon,
//      verifie aupres d'Amazon (application Fire) ;
//   3. un code d'invitation valide.
//
// EXCEPTION -- application Fire (User-Agent "SpectraAmazon/...") : la creation
// du compte est LIBRE, sans paiement ni code. Le compte est cree sans
// abonnement ; l'application affiche alors l'ecran d'abonnement Amazon, et
// l'acces s'ouvre quand l'achat integre est verifie (/amazon/verify). Avant,
// "Creer un compte" renvoyait une erreur tant qu'on n'avait pas deja paye,
// ce qui empechait un testeur d'Amazon (ou un nouveau client) d'aller plus loin.
// Le mur d'acces reste intact : sans abonnement, /billing/status repond
// "inactive". Sur le site web, rien ne change : paiement ou invitation d'abord.
router.post('/register', async (req, res) => {
  try {
    const { email, password, displayName, role, inviteCode } = req.body || {};
    if (!email || !password || !role) {
      return res.status(400).json({ error: 'email, password et role sont requis.' });
    }
    if (!['person', 'caregiver'].includes(role)) {
      return res.status(400).json({ error: 'role doit valoir "person" ou "caregiver".' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caracteres.' });
    }
    const normalizedEmail = email.toLowerCase();
    const existing = await db.get('SELECT id FROM users WHERE email = ?', [normalizedEmail]);
    if (existing) return res.status(409).json({ error: 'Un compte existe deja avec cet email.' });

    const { isEmailPaid } = require('./billing');
    const amazon = require('../amazon');
    let authorized = await isEmailPaid(normalizedEmail);
    let usedInvite = null;
    let amazonAccepte = null; // preuve d'achat Amazon verifiee

    // Achat integre de l'Appstore Amazon : le serveur demande a Amazon si le
    // recu est reel et en cours. Aucune confiance n'est accordee a l'application.
    const preuveAmazon = (req.body || {}).amazon;
    if (!authorized && preuveAmazon) {
      const entree = amazon.lireEntree(preuveAmazon);
      if (entree.erreur) {
        return res.status(400).json({ error: entree.erreur, code: 'AMAZON_INVALID_REQUEST' });
      }
      const verification = await amazon.verifierRecus(entree.userId, entree.receiptIds);
      if (verification.etat === 'temporaire' || verification.etat === 'config') {
        res.set('Retry-After', '30');
        return res.status(503).json({
          error: 'La verification de votre achat aupres d\'Amazon est momentanement indisponible. Rien n\'est perdu : reessayez dans un instant.',
          code: 'AMAZON_UNAVAILABLE',
          retry: true,
        });
      }
      if (verification.etat === 'valide') {
        amazonAccepte = { userId: entree.userId, verification };
        authorized = true;
      }
    }

    if (!authorized && inviteCode) {
      const invite = await db.get('SELECT * FROM invite_codes WHERE code = ?', [inviteCode.toUpperCase()]);
      if (invite && !invite.used_at && new Date(invite.expires_at) >= new Date()) {
        if (invite.inviter_id) {
          const inviter = await db.get('SELECT id, email FROM users WHERE id = ?', [invite.inviter_id]);
          if (inviter && await isEmailPaid(inviter.email)) { authorized = true; usedInvite = invite; }
        } else {
          const stillPaid = await isEmailPaid(invite.source_email);
          if (stillPaid) { authorized = true; usedInvite = invite; }
        }
      }
    }

    // Compte libre : application Fire, sans preuve d'achat ni code d'invitation.
    let compteLibre = false;
    if (!authorized) {
      const dansAppAmazon = amazon.estAppAmazon(req);
      if (dansAppAmazon && !preuveAmazon && !String(inviteCode || '').trim()) {
        compteLibre = true;
      } else if (dansAppAmazon && !preuveAmazon) {
        // Un code a ete saisi mais il n'est pas valable (inconnu, deja utilise,
        // expire, ou son parrain n'est plus abonne) : on le dit, plutot que de
        // creer en silence un compte sans acces. Aucun autre moyen de paiement
        // n'est mentionne (regle de l'Appstore).
        return res.status(402).json({
          error: 'Ce code d\'invitation n\'est pas valable (inconnu, deja utilise, expire, ou la personne qui l\'a cree n\'est plus abonnee). Verifiez-le, ou laissez ce champ vide : vous creerez votre compte puis vous vous abonnerez.',
          code: 'INVITE_INVALID',
        });
      } else {
        // Dans l'application Amazon, on ne renvoie vers aucun autre moyen de
        // paiement (regle de l'Appstore) : le message parle uniquement de l'achat integre.
        const message = dansAppAmazon
          ? 'Aucun abonnement actif n\'a ete trouve. Abonnez-vous depuis l\'ecran d\'abonnement de l\'application, ou saisissez le code d\'invitation de la personne qui a deja un compte.'
          : 'Aucun paiement confirme pour cet email, et aucun code d\'invitation valide fourni. Abonnez-vous d\'abord, ou demandez un code d\'invitation a la personne qui a deja un compte.';
        return res.status(402).json({ error: message, code: 'PAYMENT_REQUIRED' });
      }
    }

    const id = randomUUID();
    const passwordHash = await bcrypt.hash(password, 10);
    const insertUser = 'INSERT INTO users (id, email, password_hash, display_name, role, invited_via) VALUES (?, ?, ?, ?, ?, ?)';
    const valeursUser = [id, normalizedEmail, passwordHash, displayName || '', role, usedInvite ? usedInvite.code : null];
    if (amazonAccepte) {
      // Compte et abonnement Amazon crees ENSEMBLE : si le rattachement echoue,
      // le compte n'est pas cree non plus, et l'achat reste utilisable.
      try {
        await db.transaction(async (t) => {
          await t.run(insertUser, valeursUser);
          await amazon.enregistrer(t, { email: normalizedEmail, userId: amazonAccepte.userId, verification: amazonAccepte.verification });
        });
      } catch (e) {
        if (e.code === 'AMAZON_ALREADY_LINKED' || (e.code === '23505' && /amazon/.test(e.constraint || ''))) {
          return res.status(409).json({
            error: 'Cet abonnement Amazon est deja rattache a un autre compte Spectra'
              + (e.emailMasque ? ' (' + e.emailMasque + ')' : '')
              + '. Connectez-vous avec ce compte.',
            code: 'AMAZON_ALREADY_LINKED',
          });
        }
        if (e.code === 'AMAZON_OTHER_ACCOUNT') {
          return res.status(409).json({ error: e.message, code: 'AMAZON_OTHER_ACCOUNT' });
        }
        throw e;
      }
    } else {
      await db.run(insertUser, valeursUser);
    }

    if (usedInvite) {
      if (usedInvite.inviter_id && usedInvite.inviter_role && usedInvite.inviter_role !== role) {
        const personId = usedInvite.inviter_role === 'person' ? usedInvite.inviter_id : id;
        const caregiverId = usedInvite.inviter_role === 'caregiver' ? usedInvite.inviter_id : id;
        await db.run(
          'INSERT INTO links (id, person_id, caregiver_id, role_label) VALUES (?, ?, ?, ?) ON CONFLICT (person_id, caregiver_id) DO NOTHING',
          [randomUUID(), personId, caregiverId, usedInvite.role_label || '']
        );
      }
      await db.run('UPDATE invite_codes SET used_at = now() WHERE code = ?', [usedInvite.code]);
    }

    const user = { id, email: normalizedEmail, role };
    res.status(201).json({
      token: signToken(user),
      user: { id, email: user.email, role, displayName: displayName || '' },
      subscriptionRequired: compteLibre,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur serveur lors de la creation du compte.' });
  }
});

// POST /auth/login  { email, password }
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email et password sont requis.' });

    const row = await db.get('SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);
    if (!row) return res.status(401).json({ error: 'Identifiants invalides.' });

    const ok = await bcrypt.compare(password, row.password_hash);
    if (!ok) return res.status(401).json({ error: 'Identifiants invalides.' });

    const user = { id: row.id, email: row.email, role: row.role };
    res.json({ token: signToken(user), user: { id: row.id, email: row.email, role: row.role, displayName: row.display_name } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur serveur lors de la connexion.' });
  }
});

// GET /auth/me
router.get('/me', requireAuth, async (req, res) => {
  const row = await db.get('SELECT id, email, role, display_name FROM users WHERE id = ?', [req.user.sub]);
  if (!row) return res.status(404).json({ error: 'Compte introuvable.' });
  res.json({ user: { id: row.id, email: row.email, role: row.role, displayName: row.display_name } });
});

// ---------------------------------------------------------------------------
// Mot de passe oublie. Sans ces routes, un client qui oubliait son mot de
// passe n'avait plus aucun recours : ni support, ni reinitialisation.
// ---------------------------------------------------------------------------

// POST /auth/forgot  { email }
// Repond toujours 200, meme si l'adresse est inconnue : sinon, la reponse
// permet de savoir qui est client de Spectra, donc qui est concerne par
// l'autisme. C'est une donnee qu'on ne divulgue pas.
router.post('/forgot', async (req, res) => {
  const { email } = req.body || {};
  const generic = { ok: true, message: 'Si un compte existe pour cette adresse, un e-mail vient d\'etre envoye.' };
  if (!email) return res.json(generic);

  const user = await db.get('SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);
  if (user) {
    const token = signResetToken(user);
    const result = await sendPasswordResetEmail({ to: user.email, token });
    if (!result.sent) console.error('[auth] E-mail de reinitialisation non envoye :', result.reason);
  }
  res.json(generic);
});

function resetPage({ token, error, done }) {
  const style = 'font:400 16px/1.6 system-ui,-apple-system,Roboto,Helvetica,sans-serif;'
    + 'background:#F7F8F6;color:#2B3230;max-width:26rem;margin:3rem auto;padding:0 1.25rem';
  if (done) {
    return `<!doctype html><html lang="fr"><meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <title>Mot de passe modifie</title><body style="${style}">
      <h1 style="font-size:1.4rem">Mot de passe modifie</h1>
      <p>Vous pouvez maintenant vous connecter a Spectra avec votre nouveau mot de passe.</p>
      </body></html>`;
  }
  return `<!doctype html><html lang="fr"><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Nouveau mot de passe</title><body style="${style}">
    <h1 style="font-size:1.4rem">Choisir un nouveau mot de passe</h1>
    ${error ? `<p style="color:#A3402F">${error}</p>` : ''}
    <form method="post" action="/auth/reset">
      <input type="hidden" name="token" value="${token || ''}">
      <label for="p">Nouveau mot de passe (8 caracteres minimum)</label><br>
      <input id="p" name="password" type="password" minlength="8" required autocomplete="new-password"
        style="width:100%;padding:.6rem;margin:.5rem 0 1rem;border:1px solid #DDE3DF;border-radius:8px;font-size:1rem"><br>
      <button type="submit"
        style="background:#3F6B5E;color:#fff;border:0;border-radius:8px;padding:.7rem 1.2rem;font-size:1rem">
        Enregistrer</button>
    </form></body></html>`;
}

// GET /auth/reset?token=...  -- formulaire minimal servi par le serveur, pour
// que la reinitialisation fonctionne meme sans page dediee cote site.
router.get('/reset', (req, res) => {
  res.type('html').send(resetPage({ token: req.query.token }));
});

// POST /auth/reset  { token, password }  (JSON ou formulaire)
router.post('/reset', express.urlencoded({ extended: false }), async (req, res) => {
  const wantsJson = req.is('application/json');
  const { token, password } = req.body || {};
  const fail = (msg) => wantsJson
    ? res.status(400).json({ error: msg })
    : res.status(400).type('html').send(resetPage({ token, error: msg }));

  if (!token || !password) return fail('Lien ou mot de passe manquant.');
  if (String(password).length < 8) return fail('Le mot de passe doit contenir au moins 8 caracteres.');

  const userId = peekSubject(token);
  if (!userId) return fail('Ce lien n\'est pas valide.');

  const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) return fail('Ce lien n\'est plus valide.');

  try {
    verifyResetToken(token, user.password_hash);
  } catch (e) {
    return fail('Ce lien a expire ou a deja ete utilise. Demandez-en un nouveau.');
  }

  const passwordHash = await bcrypt.hash(password, 10);
  await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, user.id]);

  return wantsJson
    ? res.json({ ok: true })
    : res.type('html').send(resetPage({ done: true }));
});

module.exports = router;
