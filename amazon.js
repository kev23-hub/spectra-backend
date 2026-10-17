// routes/amazon.js
//
// Achats integres de l'Appstore Amazon (application Fire).
// La logique de verification est dans ../amazon.js ; ici, seulement l'HTTP.
//
// Monte dans server.js :  app.use('/amazon', require('./routes/amazon'));
// (volontairement hors de /billing : l'application Fire bloque toute
// NAVIGATION vers un chemin /billing/, et on ne veut aucune confusion.)

const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { requireAuth, sessionFacultative } = require('../auth');
const amazon = require('../amazon');
const { isEmailPaid } = require('./billing');

const EMAIL_OK = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const router = express.Router();

// Chaque appel peut declencher des requetes vers Amazon : on borne le debit.
const limiteur = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.DISABLE_RATE_LIMIT === '1',
  message: { error: 'Trop de tentatives. Reessayez dans quelques minutes.' },
});

// GET /amazon/etat -- le serveur est-il pret a verifier des achats ?
// Ne revele aucun secret : simple controle pour vous apres un deploiement.
//   pret        la cle Amazon (AMAZON_RVS_SECRET) est en place
//   relecteurs  nombre de comptes de test prets pour les relecteurs d'Amazon
//               (0 a 2 ; voir reviewers.js)
router.get('/etat', async (req, res) => {
  let relecteurs = null;
  try { relecteurs = await require('../reviewers').compter(); } catch (e) { /* base injoignable : on repond quand meme */ }
  res.json({ pret: amazon.pret(), relecteurs });
});

// POST /amazon/verify  -- DEUX FORMATS, meme adresse.
//
// (1) FORMAT DE LA PAGE DU SITE (spectra-amazon.js), connexion FACULTATIVE :
//       Corps : { receiptId, amazonUserId, email? }
//     La page verifie l'achat AVANT que le compte existe : l'acheteur saisit son
//     e-mail, achete, et le serveur rattache l'abonnement a cet e-mail ; il peut
//     ensuite creer son compte (l'e-mail est alors reconnu comme paye).
//     E-mail retenu, dans l'ordre : le compte connecte ; l'e-mail du corps ; le
//     compte deja rattache a cet identifiant Amazon.
//
//     200 { active, email, alreadyLinkedToOtherEmail, accountExists, status,
//           currentPeriodEnd, amazon, receiptsToConfirm, cached }
//           active                    -> abonnement Amazon en cours pour cet e-mail
//           alreadyLinkedToOtherEmail -> ce compte Amazon sert deja un AUTRE e-mail ;
//                                        `email` est alors masque (a***@gmail.com)
//           accountExists             -> un compte Spectra existe deja pour cet e-mail
//                                        (la page propose "se connecter", pas "creer")
//     200 { active:false, code:'AMAZON_RECEIPT_CANCELED' }   achat annule / termine
//     400 EMAIL_REQUIRED             aucun e-mail connu pour cet achat
//     400 AMAZON_INVALID_REQUEST     donnees mal formees
//     400 AMAZON_RECEIPT_INVALID     Amazon ne reconnait pas ce recu
//     409 AMAZON_OTHER_ACCOUNT       cet e-mail est deja abonne via un autre compte Amazon
//     503 AMAZON_UNAVAILABLE         Amazon injoignable : reessayer plus tard
async function verifierFormatPage(req, res, next) {
  const corps = req.body && typeof req.body === 'object' ? req.body : {};
  // Ancien format { userId, receiptIds } : connexion obligatoire, voir plus bas.
  if (corps.userId !== undefined || corps.receiptIds !== undefined) return next();

  const entree = amazon.lireEntree({ userId: corps.amazonUserId, receiptId: corps.receiptId });
  if (entree.erreur) {
    return res.status(400).json({ error: entree.erreur, code: 'AMAZON_INVALID_REQUEST', active: false });
  }
  const userId = entree.userId;
  const receiptId = entree.receiptIds[0];

  // 1. Pour quel e-mail Spectra ?
  let email = null;
  const session = sessionFacultative(req);
  if (session) {
    const u = await db.get('SELECT email FROM users WHERE id = ?', [session.sub]);
    if (u) email = u.email.toLowerCase(); // compte supprime : le jeton est ignore
  }
  if (!email && corps.email !== undefined && corps.email !== null && String(corps.email).trim() !== '') {
    const saisi = typeof corps.email === 'string' ? corps.email.trim().toLowerCase() : '';
    if (saisi.length > 254 || !EMAIL_OK.test(saisi)) {
      return res.status(400).json({ error: 'Adresse e-mail invalide.', code: 'AMAZON_INVALID_REQUEST', active: false });
    }
    email = saisi;
  }

  const lie = await db.get('SELECT * FROM paid_emails WHERE amazon_user_id = ?', [userId]);
  let emailEffectif = email;
  let autreEmail = false;
  if (lie && (!email || lie.email !== email)) {
    // Ce compte Amazon sert deja un e-mail Spectra : c'est SON abonnement. On met
    // a jour cet e-mail-la (jamais un autre), et on ne le montre que masque.
    emailEffectif = lie.email;
    autreEmail = true;
  }
  if (!emailEffectif) {
    return res.status(400).json({
      error: 'Indiquez l\'adresse e-mail de votre compte Spectra.',
      code: 'EMAIL_REQUIRED',
      active: false,
    });
  }

  const reponse = async (ligne, extra = {}) => {
    const r = amazon.resume(ligne);
    // Un compte Spectra existe-t-il deja pour cet e-mail ? La page propose alors
    // "se connecter" plutot que "creer un compte" (reinstallation, autre tablette).
    const compte = await db.get('SELECT 1 AS present FROM users WHERE email = ?', [emailEffectif]);
    return {
      active: r.active,
      email: autreEmail ? amazon.masquerEmail(emailEffectif) : emailEffectif,
      alreadyLinkedToOtherEmail: autreEmail,
      accountExists: !!compte,
      status: r.status,
      currentPeriodEnd: r.currentPeriodEnd,
      amazon: r,
      ...extra,
    };
  };

  // 2. Meme recu verifie il y a moins de 10 minutes : inutile de re-interroger Amazon.
  const avant = lie && lie.email === emailEffectif
    ? lie
    : await db.get('SELECT * FROM paid_emails WHERE email = ?', [emailEffectif]);
  if (amazon.cacheValide(avant, userId, [receiptId])) {
    return res.json(await reponse(avant, { receiptsToConfirm: [receiptId], cached: true }));
  }

  // 3. Demander a Amazon (jamais de confiance accordee a l'application).
  const verification = await amazon.verifierRecus(userId, [receiptId]);
  if (verification.etat === 'temporaire' || verification.etat === 'config') {
    res.set('Retry-After', '30');
    return res.status(503).json({
      error: 'La verification de votre achat aupres d\'Amazon est momentanement indisponible. Rien n\'est perdu : reessayez dans un instant.',
      code: 'AMAZON_UNAVAILABLE',
      active: false,
      retry: true,
    });
  }

  // Reponse quand Amazon ne reconnait pas, ou ne valide plus, ce recu.
  const refuser = async (apres) => {
    if (verification.details.some(d => d.raison === 'RECU_ANNULE')) {
      return res.json(await reponse(apres, {
        active: false, status: 'canceled', code: 'AMAZON_RECEIPT_CANCELED', receiptsToConfirm: [], cached: false,
      }));
    }
    return res.status(400).json({
      error: 'Amazon ne reconnait pas cet achat.',
      code: 'AMAZON_RECEIPT_INVALID',
      active: false,
    });
  };

  // 4. Enregistrer le resultat.
  // Un recu refuse par Amazon n'a RIEN a enregistrer tant qu'aucun e-mail n'est
  // rattache a ce compte Amazon : on repond sans toucher a la base. Surtout, on
  // ne va pas voir ce que contient la ligne de l'e-mail saisi : sinon un faux recu
  // permettrait de sonder gratuitement quelles adresses ont un abonnement.
  if (verification.etat === 'invalide' && !lie) return refuser(null);

  let apres;
  try {
    apres = await db.transaction((t) => amazon.enregistrer(t, { email: emailEffectif, userId, verification }));
  } catch (e) {
    if (e.code === 'AMAZON_ALREADY_LINKED' || e.code === '23505') {
      // Course : une autre demande vient de rattacher ce compte Amazon a un autre e-mail.
      const gagnant = await db.get('SELECT email FROM paid_emails WHERE amazon_user_id = ?', [userId]);
      if (!gagnant || gagnant.email === emailEffectif) {
        return res.status(409).json({
          error: 'Cet abonnement Amazon est deja rattache a un autre compte Spectra.',
          code: 'AMAZON_ALREADY_LINKED',
          active: false,
        });
      }
      emailEffectif = gagnant.email;
      autreEmail = true;
      apres = await db.transaction((t) => amazon.enregistrer(t, { email: emailEffectif, userId, verification }));
    } else if (e.code === 'AMAZON_OTHER_ACCOUNT') {
      return res.status(409).json({ error: e.message, code: 'AMAZON_OTHER_ACCOUNT', active: false });
    } else {
      throw e;
    }
  }

  if (verification.etat === 'valide') {
    return res.json(await reponse(apres, { receiptsToConfirm: [receiptId], cached: false }));
  }
  return refuser(apres);
}

// (2) ANCIEN FORMAT, connexion REQUISE :
//   Corps : { userId, receiptIds: [..] }   ou   { userId, receiptId }
//     userId     identifiant Amazon de l'acheteur (fourni par l'application)
//     receiptIds recus NON annules renvoyes par l'application (10 au maximum)
//
//   200 : { active, amazon: { active, status, currentPeriodEnd },
//           receiptsToConfirm: [..], cached }
//         active            -> le compte a-t-il acces (Amazon, Stripe, ...)
//         receiptsToConfirm -> recus a confirmer a Amazon (confirmerLivraison)
//   400 AMAZON_INVALID_REQUEST   donnees mal formees
//   409 AMAZON_ALREADY_LINKED    cet abonnement Amazon sert deja un autre compte
//   409 AMAZON_OTHER_ACCOUNT     ce compte est deja abonne via un autre compte Amazon
//   503 AMAZON_UNAVAILABLE       Amazon injoignable : reessayer plus tard
router.post('/verify', limiteur, verifierFormatPage, requireAuth, async (req, res) => {
  const entree = amazon.lireEntree(req.body);
  if (entree.erreur) {
    return res.status(400).json({ error: entree.erreur, code: 'AMAZON_INVALID_REQUEST' });
  }

  // Un jeton reste valable 30 jours : on s'assure que le compte existe encore,
  // sinon un compte supprime pourrait recreer une ligne d'abonnement.
  const user = await db.get('SELECT id, email FROM users WHERE id = ?', [req.user.sub]);
  if (!user) return res.status(401).json({ error: 'Compte introuvable.' });
  const email = user.email.toLowerCase();

  // Meme recu verifie il y a moins de 10 minutes : inutile de re-interroger Amazon.
  const avant = await db.get('SELECT * FROM paid_emails WHERE email = ?', [email]);
  if (amazon.cacheValide(avant, entree.userId, entree.receiptIds)) {
    return res.json({
      active: true,
      amazon: amazon.resume(avant),
      receiptsToConfirm: [avant.amazon_receipt_id],
      cached: true,
    });
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

  let apres;
  try {
    apres = await db.transaction((t) => amazon.enregistrer(t, { email, userId: entree.userId, verification }));
  } catch (e) {
    // 23505 : deux demandes simultanees ont tente de rattacher le meme compte Amazon.
    if (e.code === 'AMAZON_ALREADY_LINKED' || e.code === '23505') {
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

  res.json({
    active: await isEmailPaid(email),
    amazon: amazon.resume(apres),
    receiptsToConfirm: verification.etat === 'valide' ? verification.valides.map(v => v.receiptId) : [],
    cached: false,
  });
});

module.exports = router;
