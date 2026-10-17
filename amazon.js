// amazon.js
//
// Verification des achats faits dans l'application Fire via l'Appstore Amazon.
//
// POURQUOI CE FICHIER
// Dans l'application Amazon, la regle de l'Appstore impose de vendre
// l'abonnement avec SON systeme d'achat integre (In-App Purchasing), pas avec
// Stripe. Le serveur ne peut pas se fier a l'application ("j'ai paye") : il
// interroge Amazon, avec une cle secrete que seul le serveur connait, pour
// savoir si le recu est reel et si l'abonnement court encore. C'est le
// "Receipt Verification Service" (RVS) d'Amazon.
//
// Stripe n'est PAS touche : un e-mail peut avoir un abonnement Stripe (site
// web), un abonnement Amazon (application Fire), ou les deux. L'acces est
// ouvert si l'un des deux est actif. Les deux circuits ecrivent dans des
// colonnes separees de paid_emails, donc aucun ne peut ecraser l'autre.
//
// Variables d'environnement (voir .env.example) :
//   AMAZON_RVS_SECRET   cle partagee, sur developer.amazon.com (page "Shared Key").
//                       OBLIGATOIRE pour accepter de vrais achats. Ne jamais la
//                       coller dans une conversation ni dans Git.
//   AMAZON_RVS_MODE     production (defaut) | auto | sandbox
//                       - production : seuls les vrais recus Amazon sont acceptes.
//                       - auto       : essaie la production, puis le bac a sable
//                         (recus de l'outil de test "App Tester"). A n'utiliser
//                         QUE pendant vos essais, puis a retirer.
//                       - sandbox    : bac a sable uniquement (developpement).
//   AMAZON_SKUS         (optionnel) liste d'identifiants de produit acceptes,
//                       separes par des virgules. Si vide, tout abonnement de
//                       votre compte developpeur est accepte.
//   AMAZON_GRACE_DAYS   (optionnel, defaut 3) jours d'acces conserves apres la
//                       date de fin de periode, le temps que l'application
//                       signale le renouvellement.

const db = require('./db');

const JOUR = 24 * 3600 * 1000;
const MAX_RECUS = 10;

// Les identifiants Amazon (utilisateur, recu, cle) sont places tels quels dans
// le chemin d'une URL. On n'autorise donc QUE les caracteres qu'ils contiennent
// reellement : ni "/", ni "?", ni "#", ni "%", ni espace. Une valeur piegee ne
// peut ainsi jamais modifier l'adresse interrogee.
const RE_ID = /^[A-Za-z0-9_\-=:.+]{6,512}$/;

function nombre(valeur, defaut, min, max) {
  // Une variable laissee VIDE sur Render (AMAZON_GRACE_DAYS=) vaut "pas de
  // reglage" : sans ce test, Number('') donnerait 0 et supprimerait le delai.
  if (valeur === undefined || valeur === null || String(valeur).trim() === '') return defaut;
  const n = Number(valeur);
  return Number.isFinite(n) && n >= min && n <= max ? n : defaut;
}

// Lue a chaque appel (et non une seule fois au chargement) : un changement de
// variable sur Render s'applique des le redemarrage, et les tests peuvent
// faire varier la configuration.
function config() {
  const brut = String(process.env.AMAZON_RVS_MODE || 'production').trim().toLowerCase();
  const mode = ['production', 'auto', 'sandbox'].includes(brut) ? brut : 'production';
  return {
    mode,
    modeInconnu: brut !== mode,
    // On tolere les guillemets et espaces colles par erreur autour de la cle.
    secret: String(process.env.AMAZON_RVS_SECRET || '').trim().replace(/^["']+|["']+$/g, '').trim(),
    hote: String(process.env.AMAZON_RVS_BASE_URL || 'https://appstore-sdk.amazon.com').replace(/\/+$/, ''),
    skus: String(process.env.AMAZON_SKUS || '').split(',').map(s => s.trim()).filter(Boolean),
    graceMs: nombre(process.env.AMAZON_GRACE_DAYS, 3, 0, 30) * JOUR,
    delaiMs: nombre(process.env.AMAZON_RVS_TIMEOUT_MS, 8000, 1000, 30000),
    cacheMs: 10 * 60 * 1000,
  };
}

// Environnements interroges, dans l'ordre.
function environnements(cfg) {
  if (cfg.mode === 'sandbox') return ['sandbox'];
  if (cfg.mode === 'auto') return cfg.secret ? ['production', 'sandbox'] : ['sandbox'];
  return ['production'];
}

// Vrai si le serveur sait verifier un achat (cle presente, ou bac a sable seul).
function pret() {
  const c = config();
  return c.mode === 'sandbox' || !!c.secret;
}

// L'application Fire ajoute "SpectraAmazon/x.y.z" a son User-Agent.
function estAppAmazon(req) {
  return /SpectraAmazon\//i.test((req && req.get && req.get('user-agent')) || '');
}

function masquerId(id) {
  const s = String(id || '');
  return s.length <= 10 ? '***' : s.slice(0, 5) + '...' + s.slice(-3);
}

function masquerEmail(email) {
  const [local, domaine] = String(email || '').split('@');
  if (!domaine) return '***';
  return (local ? local[0] : '') + '***@' + domaine;
}

// Retire la cle secrete de tout texte destine aux journaux.
function nettoyer(texte, cfg) {
  let s = String(texte || '');
  if (cfg && cfg.secret) s = s.split(cfg.secret).join('***');
  return s;
}

function erreur(code, message, extra) {
  const e = new Error(message);
  e.code = code;
  return Object.assign(e, extra || {});
}

// --- Lecture et controle de ce que envoie l'application ----------------------
// Accepte { userId, receiptId } ou { userId, receiptIds: [...] }.
function lireEntree(corps) {
  const c = corps && typeof corps === 'object' ? corps : {};
  const userId = typeof c.userId === 'string' ? c.userId.trim() : '';
  if (!RE_ID.test(userId)) return { erreur: 'Identifiant Amazon (userId) manquant ou invalide.' };

  const bruts = [];
  if (Array.isArray(c.receiptIds)) bruts.push(...c.receiptIds);
  if (c.receiptId !== undefined && c.receiptId !== null) bruts.push(c.receiptId);

  const receiptIds = [];
  for (const r of bruts) {
    const v = typeof r === 'string' ? r.trim() : '';
    if (!RE_ID.test(v)) return { erreur: 'Un identifiant de recu Amazon (receiptId) est invalide.' };
    if (!receiptIds.includes(v)) receiptIds.push(v);
  }
  if (!receiptIds.length) return { erreur: 'Aucun recu Amazon (receiptId) fourni.' };
  if (receiptIds.length > MAX_RECUS) {
    return { erreur: `Trop de recus (${MAX_RECUS} au maximum) : n'envoyez que les recus non annules.` };
  }
  return { userId, receiptIds };
}

// --- Lecture de la reponse d'Amazon -----------------------------------------
// Date d'Amazon -> millisecondes. null = absente ; NaN = presente mais illisible.
// Amazon envoie des millisecondes ; on tolere aussi un nombre ecrit en texte ou
// une date ISO, et on distingue "absente" de "illisible" : une date d'ANNULATION
// illisible ne doit jamais etre prise pour une absence d'annulation.
function enMs(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : (v === 0 ? null : NaN);
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return Number(s) > 0 ? Number(s) : null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : NaN;
}

// Transforme la reponse JSON d'Amazon (HTTP 200) en decision.
//
// Regles d'Amazon pour un abonnement :
//  - recu valide, renouvellement automatique actif : cancelDate vide,
//    renewalDate = prochaine echeance ;
//  - renouvellement automatique coupe par le client : cancelDate = date a
//    laquelle l'abonnement s'arrete. Si elle est dans le FUTUR, la periode
//    deja payee reste due jusqu'a cette date ;
//  - cancelDate dans le PASSE : le client a perdu l'acces (fin, remboursement,
//    resiliation par le support Amazon).
function interpreterRecu(corps, maintenant = Date.now()) {
  const r = corps && typeof corps === 'object' ? corps : {};
  const base = {
    produit: r.productId || null,
    termSku: r.termSku || null,
    test: !!(r.testTransaction || r.betaProduct),
    autoRenouvelle: r.autoRenewing === true,
  };

  if (String(r.productType || '').toUpperCase() !== 'SUBSCRIPTION') {
    return { ...base, etat: 'invalide', raison: 'PRODUIT_NON_ABONNEMENT', fin: null };
  }

  const annule = enMs(r.cancelDate);
  // Date d'annulation presente mais illisible : par prudence, aucun acces.
  if (Number.isNaN(annule)) {
    return { ...base, etat: 'invalide', raison: 'DATE_ANNULATION_ILLISIBLE', fin: null, annuleLe: new Date() };
  }
  if (annule !== null && annule <= maintenant) {
    return { ...base, etat: 'invalide', raison: 'RECU_ANNULE', fin: new Date(annule), annuleLe: new Date(annule) };
  }

  let fin;
  if (annule !== null) {
    fin = annule;
  } else {
    // Paiement de renouvellement en echec : Amazon laisse parfois un delai de
    // grace (gracePeriodEndDate), durant lequel l'acces reste ouvert.
    fin = Math.max(enMs(r.renewalDate) || 0, enMs(r.gracePeriodEndDate) || 0);
  }
  // Recu valide mais sans date exploitable, ou date deja depassee alors
  // qu'Amazon n'a rien annule : on accorde un court delai et on reverifiera
  // a la prochaine ouverture de l'application.
  if (!fin || fin <= maintenant) fin = maintenant + 2 * JOUR;

  return { ...base, etat: 'valide', raison: 'OK', fin: new Date(fin) };
}

// --- Appel du service d'Amazon ----------------------------------------------
async function interroger(env, userId, receiptId, cfg) {
  // Le bac a sable ignore la cle : on ne lui envoie jamais la vraie.
  const cle = env === 'sandbox' ? 'developerSecret' : cfg.secret;
  if (env === 'production') {
    if (!cfg.secret) return { etat: 'config', env, raison: 'SECRET_ABSENT' };
    if (!RE_ID.test(cfg.secret)) return { etat: 'config', env, raison: 'SECRET_ILLISIBLE' };
  }
  const url = cfg.hote + (env === 'sandbox' ? '/sandbox' : '')
    + '/version/1.0/verifyReceiptId/developer/' + cle
    + '/user/' + userId + '/receiptId/' + receiptId;

  let res;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(cfg.delaiMs),
    });
  } catch (e) {
    return { etat: 'temporaire', env, raison: 'RESEAU', detail: nettoyer(e.message, cfg) };
  }

  const code = res.status;
  if (code === 200) {
    let corps;
    try { corps = await res.json(); } catch (e) {
      return { etat: 'temporaire', env, raison: 'REPONSE_ILLISIBLE', httpStatut: code };
    }
    const decision = interpreterRecu(corps);
    if (decision.etat === 'valide' && cfg.skus.length
        && !cfg.skus.includes(decision.produit) && !cfg.skus.includes(decision.termSku)) {
      return { ...decision, etat: 'invalide', raison: 'SKU_NON_RECONNU', env, httpStatut: code };
    }
    return { ...decision, env, httpStatut: code };
  }

  // Codes documentes par Amazon :
  //  400 transaction invalide / recu introuvable   410 recu qui n'est plus valable
  //  429 trop de requetes                          496 cle partagee refusee
  //  497 identifiant utilisateur invalide          500 erreur interne
  if (code === 400) return { etat: 'invalide', env, raison: 'RECU_INCONNU', httpStatut: code };
  if (code === 410) return { etat: 'invalide', env, raison: 'RECU_ANNULE', httpStatut: code, annuleLe: new Date() };
  if (code === 497) return { etat: 'invalide', env, raison: 'UTILISATEUR_INVALIDE', httpStatut: code };
  if (code === 496) return { etat: 'config', env, raison: 'SECRET_REFUSE', httpStatut: code };
  if (code === 429) return { etat: 'temporaire', env, raison: 'LIMITE_AMAZON', httpStatut: code };
  return { etat: 'temporaire', env, raison: 'HTTP_' + code, httpStatut: code };
}

// Verifie UN recu, dans l'ordre des environnements autorises.
async function verifierRecu(userId, receiptId, cfg = config()) {
  let dernier = null;
  for (const env of environnements(cfg)) {
    const r = await interroger(env, userId, receiptId, cfg);
    if (r.etat === 'valide') return r;
    dernier = r;
    // On ne passe au bac a sable que si la production dit "recu inconnu" :
    // jamais apres une panne, une cle refusee ou une annulation reelle.
    if (!(r.httpStatut === 400 || r.httpStatut === 497)) break;
  }
  return dernier;
}

function journaliser(userId, details) {
  for (const d of details) {
    const fin = d.fin ? ' fin=' + new Date(d.fin).toISOString() : '';
    const test = d.test ? ' (achat de test)' : '';
    const info = d.detail ? ' ' + d.detail : '';
    const ligne = `[amazon] utilisateur=${masquerId(userId)} recu=${masquerId(d.receiptId)} ${d.env}: ${d.etat}/${d.raison}${fin}${test}${info}`;
    if (d.etat === 'config') console.error(ligne + ' -> VERIFIEZ AMAZON_RVS_SECRET / AMAZON_RVS_MODE sur Render');
    else console.log(ligne);
  }
}

// Verifie plusieurs recus d'un meme utilisateur et conclut.
//   etat 'valide'     : au moins un recu en cours ; meilleur = celui qui va le plus loin.
//   etat 'invalide'   : Amazon dit clairement qu'aucun n'est valable.
//   etat 'temporaire' : impossible de conclure (panne, limite) : reessayer plus tard.
//   etat 'config'     : le serveur est mal configure (cle absente ou refusee).
async function verifierRecus(userId, receiptIds) {
  const cfg = config();
  if (cfg.modeInconnu) {
    console.error('[amazon] AMAZON_RVS_MODE a une valeur inconnue : le mode "production" est utilise.');
  }
  const details = await Promise.all(receiptIds.map(async (receiptId) => {
    const r = await verifierRecu(userId, receiptId, cfg);
    return { receiptId, ...r };
  }));
  journaliser(userId, details);

  const valides = details.filter(d => d.etat === 'valide').sort((a, b) => b.fin - a.fin);
  if (valides.length) return { etat: 'valide', meilleur: valides[0], valides, details };
  const incertains = details.filter(d => d.etat === 'temporaire' || d.etat === 'config');
  if (incertains.length) {
    return { etat: incertains.some(d => d.etat === 'config') ? 'config' : 'temporaire', details };
  }
  return { etat: 'invalide', details };
}

// --- Etat d'un abonnement Amazon dans paid_emails ---------------------------

// Acces ouvert ? La periode payee (plus le delai de grace) n'est pas finie.
// Les achats du bac a sable ne comptent plus des que le serveur repasse en
// mode "production" : les acces de test s'eteignent d'eux-memes.
function actif(ligne, maintenant = Date.now()) {
  if (!ligne || ligne.amazon_status !== 'active' || !ligne.amazon_period_end) return false;
  const cfg = config();
  if (ligne.amazon_env === 'sandbox' && cfg.mode === 'production') return false;
  return new Date(ligne.amazon_period_end).getTime() + cfg.graceMs > maintenant;
}

// Periode payee encore en cours (sans le delai de grace).
function enCours(ligne, maintenant = Date.now()) {
  return !!ligne && ligne.amazon_status === 'active' && !!ligne.amazon_period_end
    && new Date(ligne.amazon_period_end).getTime() > maintenant;
}

// Evite de redemander a Amazon le meme recu a chaque ouverture de l'application.
function cacheValide(ligne, userId, receiptIds, maintenant = Date.now()) {
  const cfg = config();
  return !!ligne && ligne.amazon_user_id === userId
    && receiptIds.includes(ligne.amazon_receipt_id)
    && !!ligne.amazon_verified_at
    && (maintenant - new Date(ligne.amazon_verified_at).getTime()) < cfg.cacheMs
    && enCours(ligne, maintenant) && actif(ligne, maintenant);
}

function resume(ligne) {
  return {
    active: actif(ligne),
    status: ligne && ligne.amazon_status ? ligne.amazon_status : null,
    currentPeriodEnd: ligne && ligne.amazon_period_end ? new Date(ligne.amazon_period_end).toISOString() : null,
  };
}

// Enregistre le resultat d'une verification pour le compte `email`.
// `t` est soit db, soit l'objet fourni par db.transaction.
//
// Regles :
//  - un compte Amazon (userId) n'est rattache qu'a UN e-mail Spectra : sinon un
//    seul abonnement pourrait ouvrir autant de comptes qu'on le souhaite ;
//  - un recu plus ancien ne raccourcit jamais une periode deja verifiee ;
//  - une annulation n'est enregistree que si elle concerne le recu qui donne
//    actuellement l'acces (un vieux recu expire ne doit pas couper un
//    abonnement renouvele).
async function enregistrer(t, { email, userId, verification }) {
  email = String(email).toLowerCase();

  const lieA = await t.get('SELECT email FROM paid_emails WHERE amazon_user_id = ?', [userId]);
  if (lieA && lieA.email !== email) {
    throw erreur('AMAZON_ALREADY_LINKED',
      'Cet abonnement Amazon est deja rattache a un autre compte Spectra.',
      { emailMasque: masquerEmail(lieA.email) });
  }

  const ligne = await t.get('SELECT * FROM paid_emails WHERE email = ?', [email]);
  if (ligne && ligne.amazon_user_id && ligne.amazon_user_id !== userId && actif(ligne)) {
    throw erreur('AMAZON_OTHER_ACCOUNT',
      'Ce compte Spectra est deja abonne via un autre compte Amazon.');
  }

  if (verification.etat === 'valide') {
    const m = verification.meilleur;
    let fin = m.fin;
    let recu = m.receiptId;
    let env = m.env;
    const memeLiaison = !!ligne && ligne.amazon_user_id === userId;
    if (memeLiaison && ligne.amazon_status === 'active' && ligne.amazon_period_end
        && ligne.amazon_receipt_id !== recu && new Date(ligne.amazon_period_end) > fin) {
      fin = new Date(ligne.amazon_period_end);
      recu = ligne.amazon_receipt_id;
      env = ligne.amazon_env || env;
    }
    // status = 'none' pour une ligne creee ici : la colonne "status" concerne
    // Stripe, et 'none' n'est pas un statut d'acces.
    await t.run(`
      INSERT INTO paid_emails
        (email, status, amazon_user_id, amazon_receipt_id, amazon_status, amazon_period_end, amazon_verified_at, amazon_env)
      VALUES (?, 'none', ?, ?, 'active', ?, now(), ?)
      ON CONFLICT (email) DO UPDATE SET
        amazon_user_id = EXCLUDED.amazon_user_id,
        amazon_receipt_id = EXCLUDED.amazon_receipt_id,
        amazon_status = 'active',
        amazon_period_end = EXCLUDED.amazon_period_end,
        amazon_verified_at = now(),
        amazon_env = EXCLUDED.amazon_env,
        updated_at = now()
    `, [email, userId, recu, fin.toISOString(), env]);
  } else if (verification.etat === 'invalide' && ligne && ligne.amazon_user_id === userId && ligne.amazon_receipt_id) {
    const concerne = verification.details.find(d =>
      d.receiptId === ligne.amazon_receipt_id && d.etat === 'invalide'
      && (d.raison === 'RECU_ANNULE' || d.raison === 'RECU_INCONNU'));
    if (concerne) {
      await t.run(`
        UPDATE paid_emails
        SET amazon_status = 'canceled', amazon_period_end = ?, amazon_verified_at = now(), updated_at = now()
        WHERE email = ?
      `, [(concerne.annuleLe || new Date()).toISOString(), email]);
    }
  }
  return t.get('SELECT * FROM paid_emails WHERE email = ?', [email]);
}

// --- Reverification a la demande ----------------------------------------------
// IMPORTANT : Amazon ne renvoie plus le recu d'un abonnement qui continue
// normalement. Une fois livre (confirmerLivraison), l'application ne le signale
// plus. Le serveur ne connait donc les renouvellements mensuels (et les
// resiliations) que s'il interroge LUI-MEME Amazon avec le recu deja enregistre.
// Sans cela, tout abonne perdrait l'acces un mois (+ delai de grace) apres son
// achat, meme si Amazon a bien renouvele. Meme rythme que pour Stripe : 12 h.
const DELAI_REVERIFICATION_MS = 12 * 3600 * 1000;
const PAUSE_APRES_PANNE_MS = 60 * 1000;
const dernieresPannes = new Map(); // email -> instant de la derniere panne d'Amazon

// Faut-il redemander a Amazon l'etat de l'abonnement enregistre pour cette ligne ?
function aRafraichir(ligne, maintenant = Date.now()) {
  if (!ligne || !ligne.amazon_user_id || !ligne.amazon_receipt_id || ligne.amazon_status !== 'active') return false;
  const cfg = config();
  // Un acces de test (bac a sable) ne compte plus en production : rien a verifier.
  if (ligne.amazon_env === 'sandbox' && cfg.mode === 'production') return false;
  // Serveur sans cle Amazon : on ne tente rien (et on ne remplit pas les journaux d'erreurs).
  if (!pret()) return false;
  const vu = ligne.amazon_verified_at ? new Date(ligne.amazon_verified_at).getTime() : 0;
  return maintenant - vu > DELAI_REVERIFICATION_MS;
}

// Revérifie l'abonnement Amazon deja enregistre pour `email`, si le dernier
// controle est ancien. Renvoie la ligne paid_emails (mise a jour ou non).
// Ne retire JAMAIS rien en cas de panne d'Amazon : l'acces court alors jusqu'a
// la fin de periode (+ delai de grace) et on reessaiera a l'ouverture suivante.
async function rafraichir(email) {
  email = String(email || '').toLowerCase();
  if (!email) return null;
  const ligne = await db.get('SELECT * FROM paid_emails WHERE email = ?', [email]);
  if (!aRafraichir(ligne)) return ligne || null;

  const panne = dernieresPannes.get(email);
  if (panne && Date.now() - panne < PAUSE_APRES_PANNE_MS) return ligne;

  let verification;
  try {
    verification = await verifierRecus(ligne.amazon_user_id, [ligne.amazon_receipt_id]);
  } catch (e) {
    console.error('[amazon] Reverification impossible :', nettoyer(e.message, config()));
    verification = { etat: 'temporaire' };
  }
  if (verification.etat === 'temporaire' || verification.etat === 'config') {
    if (dernieresPannes.size > 5000) dernieresPannes.clear();
    dernieresPannes.set(email, Date.now());
    return ligne;
  }
  dernieresPannes.delete(email);

  try {
    return await db.transaction(async (t) => {
      const apres = await enregistrer(t, { email, userId: ligne.amazon_user_id, verification });
      // Reponse definitive d'Amazon : on note le controle meme si rien ne change,
      // pour ne pas le refaire a chaque ouverture de l'application.
      await t.run('UPDATE paid_emails SET amazon_verified_at = now() WHERE email = ?', [email]);
      return apres;
    });
  } catch (e) {
    console.error('[amazon] Reverification : enregistrement impossible :', e.message);
    return ligne;
  }
}

module.exports = {
  MAX_RECUS, DELAI_REVERIFICATION_MS,
  config, pret, estAppAmazon, lireEntree, interpreterRecu,
  verifierRecu, verifierRecus,
  actif, enCours, cacheValide, resume, enregistrer,
  aRafraichir, rafraichir,
  masquerEmail, masquerId,
};
