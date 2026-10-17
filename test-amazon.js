// Test de bout en bout de la verification des achats Amazon.
//
// Il lance LUI-MEME :
//   - un faux service Amazon (RVS) qui repond comme le vrai : valide, annule,
//     recu inconnu, panne, cle refusee... ;
//   - un vrai serveur Spectra, sur une vraie base PostgreSQL.
//
// Lancer :  DATABASE_URL=postgres://... JWT_SECRET=... node test-amazon.js
// (utilisez une base de TEST : le test y cree des comptes d'essai.)

const http = require('http');
const { spawn } = require('child_process');
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET || 'test-secret-0123456789abcdef0123456789abcdef';
if (!DATABASE_URL) { console.error('DATABASE_URL manquante.'); process.exit(2); }
process.env.DATABASE_URL = DATABASE_URL;
process.env.JWT_SECRET = JWT_SECRET;

const amazon = require('./amazon');
const pool = new Pool({ connectionString: DATABASE_URL });
const sql = async (q, p) => (await pool.query(q, p)).rows;

const JOUR = 24 * 3600 * 1000;
const SECRET = '2:CleSecreteDeTest_abc-123:xyz789==';
const UA_AMAZON = 'Mozilla/5.0 (Linux; Android 11; KFTRWI) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36 SpectraAmazon/1.0.0';

let pass = 0, fail = 0;
const results = [];
function check(nom, ok, detail) {
  ok ? pass++ : fail++;
  results.push(`${ok ? 'OK  ' : 'ECHEC'}  ${nom}${ok ? '' : '  -> ' + detail}`);
}
const proche = (a, b, tol = 5000) => Math.abs(new Date(a).getTime() - new Date(b).getTime()) <= tol;

// --- Faux service Amazon ------------------------------------------------------
const rvsLog = [];                // chemins demandes
const recus = new Map();          // "env|recu" -> { userId, body, http }
let panne = null;                 // code HTTP force pour TOUTES les reponses
const rvs = http.createServer((req, res) => {
  rvsLog.push(req.url);
  const m = req.url.match(/^(\/sandbox)?\/version\/1\.0\/verifyReceiptId\/developer\/([^/]+)\/user\/([^/]+)\/receiptId\/([^/]+)$/);
  if (!m) { res.statusCode = 404; return res.end(); }
  const env = m[1] ? 'sandbox' : 'production';
  const [, , cle, user, recu] = m;
  if (panne) { res.statusCode = panne; return res.end('{}'); }
  if (env === 'production' && cle !== SECRET) { res.statusCode = 496; return res.end(); }
  const r = recus.get(env + '|' + recu);
  if (!r) { res.statusCode = 400; return res.end(); }
  if (r.userId !== user) { res.statusCode = 497; return res.end(); }
  if (r.http) { res.statusCode = r.http; return res.end(); }
  res.setHeader('Content-Type', 'application/json');
  if (r.brut !== undefined) return res.end(r.brut);                 // reponse illisible
  if (r.delai) return setTimeout(() => res.end(JSON.stringify(r.body)), r.delai); // reponse trop lente
  res.end(JSON.stringify(r.body));
});

// Corps de reponse d'Amazon pour un abonnement.
function abo({ renouvelle = Date.now() + 30 * JOUR, annule = null, auto = true, grace = null, type = 'SUBSCRIPTION', produit = 'spectra_monthly', test = false } = {}) {
  return {
    productId: produit, productType: type, term: '1 Month', termSku: produit + '_1m',
    purchaseDate: Date.now() - 2 * JOUR, cancelDate: annule, cancelReason: annule ? 1 : null,
    renewalDate: auto && !annule ? renouvelle : null, autoRenewing: auto, gracePeriodEndDate: grace,
    freeTrialEndDate: null, betaProduct: test, testTransaction: test, quantity: 1,
  };
}
const declarer = (env, recu, userId, body, http, extra = {}) => recus.set(env + '|' + recu, { userId, body, http, ...extra });
let compteurRecus = 0;
const idRecu = (p) => `${p}-${++compteurRecus}-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:3:11`;
const idUser = (p) => `AmzUser${p}-abcdefghijklmnopqrstuvwxyz0123456789=`;

// --- Serveur Spectra -----------------------------------------------------------
let portSuivant = 3070;
function demarrer(envSupp = {}) {
  return new Promise((resolve, reject) => {
    const port = portSuivant++;
    const env = {
      ...process.env, PORT: String(port), DATABASE_URL, JWT_SECRET,
      DISABLE_RATE_LIMIT: '1', KEEPALIVE: '0',
      AMAZON_RVS_SECRET: SECRET, AMAZON_RVS_BASE_URL: `http://127.0.0.1:${rvs.address().port}`,
      ...envSupp,
    };
    for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
    const proc = spawn('node', ['server.js'], { cwd: __dirname, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let journal = '';
    proc.stdout.on('data', d => { journal += d; });
    proc.stderr.on('data', d => { journal += d; });
    const base = `http://127.0.0.1:${port}`;
    const debut = Date.now();
    (async function attendre() {
      try { const r = await fetch(base + '/health'); if (r.ok) return resolve({ base, proc, journal: () => journal, stop: () => new Promise(f => { proc.once('exit', f); proc.kill(); }) }); } catch (e) {}
      if (Date.now() - debut > 20000) { proc.kill(); return reject(new Error('Le serveur ne demarre pas : ' + journal.slice(-500))); }
      setTimeout(attendre, 200);
    })();
  });
}
async function appel(S, methode, chemin, { token, body, ua } = {}) {
  const r = await fetch(S.base + chemin, {
    method: methode,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(ua ? { 'User-Agent': ua } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text();
  let data; try { data = JSON.parse(txt); } catch { data = txt; }
  return { status: r.status, data, headers: r.headers };
}
const inscrire = (S, email, preuve, extra = {}, ua) => appel(S, 'POST', '/auth/register', {
  body: { email, password: 'motdepasse1', role: 'caregiver', displayName: 'Essai', ...(preuve ? { amazon: preuve } : {}), ...extra }, ua,
});
const ligne = async (email) => (await sql('SELECT * FROM paid_emails WHERE email = $1', [email]))[0];
const compte = async (email) => (await sql('SELECT id FROM users WHERE email = $1', [email]))[0];

(async () => {
  await new Promise(r => rvs.listen(0, '127.0.0.1', r));

  // ===== 0. Fonctions pures (aucun serveur) ===================================
  {
    const n = Date.now();
    let d = amazon.interpreterRecu(abo({ renouvelle: n + 30 * JOUR }), n);
    check('recu a renouvellement automatique : valide jusqu\'a la prochaine echeance', d.etat === 'valide' && proche(d.fin, n + 30 * JOUR, 1000), JSON.stringify(d));
    d = amazon.interpreterRecu(abo({ auto: false, annule: n + 10 * JOUR }), n);
    check('renouvellement coupe, fin dans le futur : acces conserve jusqu\'a cette date', d.etat === 'valide' && proche(d.fin, n + 10 * JOUR, 1000), JSON.stringify(d));
    d = amazon.interpreterRecu(abo({ auto: false, annule: n - JOUR }), n);
    check('fin dans le passe : acces perdu', d.etat === 'invalide' && d.raison === 'RECU_ANNULE', JSON.stringify(d));
    d = amazon.interpreterRecu(abo({ renouvelle: n - JOUR }), n);
    check('echeance depassee sans annulation : court delai accorde (2 jours)', d.etat === 'valide' && proche(d.fin, n + 2 * JOUR, 1000), JSON.stringify(d));
    d = amazon.interpreterRecu(abo({ renouvelle: n - JOUR, grace: n + 2 * JOUR }), n);
    check('paiement en echec avec delai de grace Amazon : acces jusqu\'a la fin de la grace', d.etat === 'valide' && proche(d.fin, n + 2 * JOUR, 1000), JSON.stringify(d));
    d = amazon.interpreterRecu(abo({ type: 'CONSUMABLE' }), n);
    check('produit qui n\'est pas un abonnement : refuse', d.etat === 'invalide' && d.raison === 'PRODUIT_NON_ABONNEMENT', JSON.stringify(d));
    d = amazon.interpreterRecu({ productType: 'SUBSCRIPTION' }, n);
    check('recu sans aucune date : court delai accorde, jamais illimite', d.etat === 'valide' && d.fin.getTime() <= n + 3 * JOUR, JSON.stringify(d));
    d = amazon.interpreterRecu(abo({ test: true }), n);
    check('achat de test reconnu comme tel', d.test === true, JSON.stringify(d));
    d = amazon.interpreterRecu({ ...abo(), cancelDate: 'n\'importe quoi' }, n);
    check('date d\'annulation illisible : par prudence, aucun acces', d.etat === 'invalide', JSON.stringify(d));
    d = amazon.interpreterRecu({ ...abo({ auto: false }), cancelDate: String(n - JOUR) }, n);
    check('date d\'annulation ecrite en texte (passee) : acces perdu', d.etat === 'invalide' && d.raison === 'RECU_ANNULE', JSON.stringify(d));
    d = amazon.interpreterRecu({ ...abo({ auto: false }), cancelDate: new Date(n - JOUR).toISOString() }, n);
    check('date d\'annulation au format ISO (passee) : acces perdu', d.etat === 'invalide' && d.raison === 'RECU_ANNULE', JSON.stringify(d));
    d = amazon.interpreterRecu({ ...abo({ auto: false }), cancelDate: new Date(n + 4 * JOUR).toISOString() }, n);
    check('date d\'annulation au format ISO (future) : acces jusqu\'a cette date', d.etat === 'valide' && proche(d.fin, n + 4 * JOUR, 1000), JSON.stringify(d));
    d = amazon.interpreterRecu({ ...abo(), renewalDate: 'illisible' }, n);
    check('date de renouvellement illisible : court delai accorde, jamais illimite', d.etat === 'valide' && d.fin.getTime() <= n + 3 * JOUR, JSON.stringify(d));

    const e = amazon.lireEntree({ userId: idUser('x'), receiptId: 'ABCDEF-123=:3:11' });
    check('entree valide acceptee', !e.erreur && e.receiptIds.length === 1, JSON.stringify(e));
    check('entree : receiptId et receiptIds fusionnes sans doublon', amazon.lireEntree({ userId: idUser('x'), receiptIds: ['AAAAAA1', 'AAAAAA2'], receiptId: 'AAAAAA1' }).receiptIds.length === 2, '');
    for (const mauvais of ['abc/../../x', 'abc?x=1abc', 'abc#frag123', 'ab%2e%2e123', 'ab cdef123', '', 'court', 'a'.repeat(600)]) {
      const r = amazon.lireEntree({ userId: mauvais, receiptId: 'ABCDEF-123' });
      const r2 = amazon.lireEntree({ userId: idUser('x'), receiptId: mauvais });
      check(`entree piegee refusee (${JSON.stringify(mauvais).slice(0, 20)})`, !!r.erreur && !!r2.erreur, JSON.stringify([r, r2]));
    }
    check('entree : plus de 10 recus refuse', !!amazon.lireEntree({ userId: idUser('x'), receiptIds: Array.from({ length: 11 }, (_, i) => 'RECU-NUM-' + i) }).erreur, '');
    check('entree : aucun recu refuse', !!amazon.lireEntree({ userId: idUser('x') }).erreur, '');
    check('entree : corps vide refuse sans planter', !!amazon.lireEntree(undefined).erreur, '');

    // Variables d'environnement laissees vides, mal saisies, ou entre guillemets
    const sauve = { g: process.env.AMAZON_GRACE_DAYS, m: process.env.AMAZON_RVS_MODE, s: process.env.AMAZON_RVS_SECRET };
    process.env.AMAZON_GRACE_DAYS = '';
    check('AMAZON_GRACE_DAYS vide : valeur par defaut (3 jours), pas 0', amazon.config().graceMs === 3 * JOUR, amazon.config().graceMs);
    process.env.AMAZON_GRACE_DAYS = 'abc';
    check('AMAZON_GRACE_DAYS absurde : valeur par defaut', amazon.config().graceMs === 3 * JOUR, amazon.config().graceMs);
    process.env.AMAZON_GRACE_DAYS = '5';
    check('AMAZON_GRACE_DAYS = 5 : respecte', amazon.config().graceMs === 5 * JOUR, amazon.config().graceMs);
    process.env.AMAZON_RVS_MODE = '';
    check('AMAZON_RVS_MODE vide : production', amazon.config().mode === 'production', amazon.config().mode);
    process.env.AMAZON_RVS_MODE = ' Auto ';
    check('AMAZON_RVS_MODE " Auto " : auto', amazon.config().mode === 'auto', amazon.config().mode);
    process.env.AMAZON_RVS_MODE = 'sandbx';
    check('AMAZON_RVS_MODE faute de frappe : retombe sur production (jamais sur le bac a sable)', amazon.config().mode === 'production' && amazon.config().modeInconnu === true, amazon.config().mode);
    process.env.AMAZON_RVS_SECRET = '  "2:abc-DEF_123:xyz=="  ';
    check('AMAZON_RVS_SECRET collee avec guillemets et espaces : nettoyee', amazon.config().secret === '2:abc-DEF_123:xyz==', amazon.config().secret);
    for (const [k, v] of [['AMAZON_GRACE_DAYS', sauve.g], ['AMAZON_RVS_MODE', sauve.m], ['AMAZON_RVS_SECRET', sauve.s]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }

  // ===== 1. Serveur en mode production =========================================
  let S = await demarrer();
  const U1 = idUser('1'), R1 = idRecu('R1');
  let r;

  r = await appel(S, 'GET', '/amazon/etat');
  check('/amazon/etat : le serveur est pret', r.status === 200 && r.data.pret === true, JSON.stringify(r.data));
  r = await appel(S, 'POST', '/amazon/verify', { body: { userId: U1, receiptId: R1 } });
  check('/amazon/verify sans connexion : 401', r.status === 401, r.status);

  // --- Inscription avec un achat Amazon valide
  declarer('production', R1, U1, abo({ renouvelle: Date.now() + 30 * JOUR }));
  rvsLog.length = 0;
  r = await inscrire(S, 'a1@example.test', { userId: U1, receiptIds: [R1] });
  check('inscription avec achat Amazon valide : 201 + jeton', r.status === 201 && !!r.data.token, JSON.stringify(r.data));
  const tokenA1 = r.data.token;
  check('le serveur a interroge Amazon (production) avec la bonne cle et les bons identifiants',
    rvsLog.length === 1 && rvsLog[0] === `/version/1.0/verifyReceiptId/developer/${SECRET}/user/${U1}/receiptId/${R1}`, JSON.stringify(rvsLog));
  let l = await ligne('a1@example.test');
  check('ligne paid_emails : Amazon actif, colonne Stripe a "none", env production',
    l && l.amazon_user_id === U1 && l.amazon_status === 'active' && l.status === 'none' && l.amazon_env === 'production' && l.amazon_receipt_id === R1, JSON.stringify(l));
  check('fin de periode enregistree = echeance d\'Amazon', l && proche(l.amazon_period_end, Date.now() + 30 * JOUR, 5000), l && l.amazon_period_end);
  r = await appel(S, 'GET', '/billing/status', { token: tokenA1 });
  check('/billing/status : acces ouvert, source amazon', r.status === 200 && r.data.active === true && r.data.source === 'amazon' && r.data.status === 'active', JSON.stringify(r.data));

  // --- Un meme compte Amazon ne peut pas ouvrir un second compte
  r = await inscrire(S, 'a2@example.test', { userId: U1, receiptIds: [R1] });
  check('meme achat Amazon, autre e-mail : 409 AMAZON_ALREADY_LINKED', r.status === 409 && r.data.code === 'AMAZON_ALREADY_LINKED', JSON.stringify(r.data));
  check('... et aucun compte n\'est cree', !(await compte('a2@example.test')), '');
  check('... l\'e-mail du premier compte n\'est jamais revele en clair', !JSON.stringify(r.data).includes('a1@example.test'), JSON.stringify(r.data));

  // --- Recus refuses
  const Ux = idUser('x');
  r = await inscrire(S, 'b1@example.test', { userId: Ux, receiptIds: [idRecu('inconnu')] });
  check('recu inconnu d\'Amazon : 402 PAYMENT_REQUIRED', r.status === 402 && r.data.code === 'PAYMENT_REQUIRED', JSON.stringify(r.data));
  check('... aucun compte cree', !(await compte('b1@example.test')), '');
  const Rann = idRecu('annule'); declarer('production', Rann, Ux, abo({ auto: false, annule: Date.now() - JOUR }));
  r = await inscrire(S, 'b2@example.test', { userId: Ux, receiptIds: [Rann] });
  check('abonnement termine / rembourse : 402', r.status === 402, JSON.stringify(r.data));
  const R410 = idRecu('r410'); declarer('production', R410, Ux, null, 410);
  r = await inscrire(S, 'b3@example.test', { userId: Ux, receiptIds: [R410] });
  check('Amazon repond 410 (recu plus valable) : 402', r.status === 402, JSON.stringify(r.data));
  const Rbad = idRecu('mauvais-user'); declarer('production', Rbad, idUser('autre'), abo());
  r = await inscrire(S, 'b4@example.test', { userId: Ux, receiptIds: [Rbad] });
  check('identifiant utilisateur qui ne correspond pas au recu (497) : 402', r.status === 402, JSON.stringify(r.data));
  const Rcons = idRecu('conso'); declarer('production', Rcons, Ux, abo({ type: 'CONSUMABLE' }));
  r = await inscrire(S, 'b5@example.test', { userId: Ux, receiptIds: [Rcons] });
  check('achat qui n\'est pas un abonnement : 402', r.status === 402, JSON.stringify(r.data));
  r = await inscrire(S, 'b6@example.test', { userId: 'mauvais/id', receiptIds: [R1] });
  check('identifiant piege : 400 AMAZON_INVALID_REQUEST', r.status === 400 && r.data.code === 'AMAZON_INVALID_REQUEST', JSON.stringify(r.data));

  // --- Appli Amazon : creation de compte LIBRE (c'etait la cause du refus d'Amazon :
  //     "Creer un compte" renvoyait une erreur tant qu'on n'avait pas deja paye).
  r = await inscrire(S, 'b7@example.test', null, {}, UA_AMAZON);
  check('appli Amazon : "Creer un compte" sans paiement ni code reussit (201 + jeton, abonnement requis)',
    r.status === 201 && !!r.data.token && r.data.subscriptionRequired === true, JSON.stringify(r.data));
  check('... le compte existe, SANS aucune ligne d\'abonnement', !!(await compte('b7@example.test')) && !(await ligne('b7@example.test')), '');
  const tokenB7 = r.data.token;
  r = await appel(S, 'GET', '/billing/status', { token: tokenB7, ua: UA_AMAZON });
  check('... /billing/status dit "inactive" : le mur d\'acces reste en place', r.status === 200 && r.data.active === false && r.data.status === 'inactive', JSON.stringify(r.data));
  r = await appel(S, 'POST', '/auth/login', { body: { email: 'b7@example.test', password: 'motdepasse1' }, ua: UA_AMAZON });
  check('... la connexion de ce compte fonctionne', r.status === 200 && !!r.data.token, JSON.stringify(r.data));
  r = await inscrire(S, 'b7@example.test', null, {}, UA_AMAZON);
  check('... recreer le meme compte : 409, comme avant', r.status === 409, r.status + JSON.stringify(r.data));
  const Ub7 = idUser('b7'), Rb7 = idRecu('b7'); declarer('production', Rb7, Ub7, abo());
  r = await appel(S, 'POST', '/amazon/verify', { token: tokenB7, ua: UA_AMAZON, body: { receiptId: Rb7, amazonUserId: Ub7 } });
  check('... puis l\'achat Amazon verifie (compte connecte) ouvre l\'acces', r.status === 200 && r.data.active === true && r.data.email === 'b7@example.test', JSON.stringify(r.data));
  r = await appel(S, 'GET', '/billing/status', { token: tokenB7, ua: UA_AMAZON });
  check('... /billing/status : acces ouvert, source amazon', r.data.active === true && r.data.source === 'amazon', JSON.stringify(r.data));

  r = await inscrire(S, 'b8@example.test', null, { inviteCode: 'SPEC-ZZZZZZ' }, UA_AMAZON);
  check('appli Amazon + code d\'invitation inconnu : 402 INVITE_INVALID, aucun compte cree, aucun autre paiement cite',
    r.status === 402 && r.data.code === 'INVITE_INVALID' && !(await compte('b8@example.test')) && !/stripe|site web/i.test(r.data.error), JSON.stringify(r.data));
  r = await inscrire(S, 'b9@example.test', null, {});
  check('site web (hors appli) : sans paiement ni code, toujours refuse (402 PAYMENT_REQUIRED)',
    r.status === 402 && r.data.code === 'PAYMENT_REQUIRED' && !(await compte('b9@example.test')), JSON.stringify(r.data));
  r = await inscrire(S, 'b10@example.test', null, { inviteCode: 'SPEC-ZZZZZZ' });
  check('site web + code inconnu : toujours refuse (402), aucun compte', r.status === 402 && !(await compte('b10@example.test')), JSON.stringify(r.data));
  r = await inscrire(S, 'b11@example.test', { userId: Ux, receiptIds: [idRecu('inconnu2')] }, {}, UA_AMAZON);
  check('appli Amazon + recu refuse par Amazon : 402, pas de compte libre quand une preuve est rejetee',
    r.status === 402 && !(await compte('b11@example.test')), JSON.stringify(r.data));

  // --- Pannes : on ne decide JAMAIS a la place d'Amazon
  const Rpanne = idRecu('panne'); declarer('production', Rpanne, Ux, abo());
  for (const code of [500, 502, 429]) {
    panne = code;
    r = await inscrire(S, 'c1@example.test', { userId: Ux, receiptIds: [Rpanne] });
    check(`Amazon en panne (${code}) : 503 AMAZON_UNAVAILABLE + Retry-After`, r.status === 503 && r.data.code === 'AMAZON_UNAVAILABLE' && !!r.headers.get('retry-after'), r.status + ' ' + JSON.stringify(r.data));
    check(`... aucun compte cree (${code})`, !(await compte('c1@example.test')), '');
  }
  panne = 496;
  r = await inscrire(S, 'c1@example.test', { userId: Ux, receiptIds: [Rpanne] });
  check('cle partagee refusee (496) : 503 cote client, sans detail technique', r.status === 503 && !JSON.stringify(r.data).includes(SECRET), JSON.stringify(r.data));
  check('... et le journal du serveur dit quoi verifier, sans reveler la cle',
    /VERIFIEZ AMAZON_RVS_SECRET/.test(S.journal()) && !S.journal().includes(SECRET), S.journal().slice(-300));
  panne = null;
  r = await inscrire(S, 'c1@example.test', { userId: Ux, receiptIds: [Rpanne] });
  check('Amazon revenu : la meme inscription reussit (rien n\'etait perdu)', r.status === 201, JSON.stringify(r.data));

  // --- /amazon/verify : memoire courte, renouvellement, annulation
  rvsLog.length = 0;
  r = await appel(S, 'POST', '/amazon/verify', { token: tokenA1, body: { userId: U1, receiptIds: [R1] } });
  check('verify < 10 min apres : reponse en memoire, Amazon non interroge', r.status === 200 && r.data.cached === true && r.data.active === true && rvsLog.length === 0, JSON.stringify(r.data) + ' ' + rvsLog.length);
  check('... receiptsToConfirm contient le recu', JSON.stringify(r.data.receiptsToConfirm) === JSON.stringify([R1]), JSON.stringify(r.data));

  await sql("UPDATE paid_emails SET amazon_verified_at = now() - interval '1 hour' WHERE email = 'a1@example.test'");
  const R2 = idRecu('R2'); const fin2 = Date.now() + 60 * JOUR;
  declarer('production', R2, U1, abo({ renouvelle: fin2 }));
  declarer('production', R1, U1, abo({ auto: false, annule: Date.now() - JOUR })); // l'ancien terme est termine
  rvsLog.length = 0;
  r = await appel(S, 'POST', '/amazon/verify', { token: tokenA1, body: { userId: U1, receiptIds: [R1, R2] } });
  l = await ligne('a1@example.test');
  check('renouvellement : le nouveau recu est retenu, periode prolongee', r.status === 200 && r.data.cached === false && l.amazon_receipt_id === R2 && proche(l.amazon_period_end, fin2), JSON.stringify(r.data) + ' ' + JSON.stringify(l));
  check('... seul le recu valide est a confirmer', JSON.stringify(r.data.receiptsToConfirm) === JSON.stringify([R2]), JSON.stringify(r.data));
  check('... les deux recus ont ete verifies aupres d\'Amazon', rvsLog.length === 2, rvsLog.length);

  // Un recu plus ancien ne raccourcit pas la periode
  const Rvieux = idRecu('vieux'); declarer('production', Rvieux, U1, abo({ renouvelle: Date.now() + 5 * JOUR }));
  r = await appel(S, 'POST', '/amazon/verify', { token: tokenA1, body: { userId: U1, receiptIds: [Rvieux] } });
  l = await ligne('a1@example.test');
  check('un recu plus ancien ne raccourcit pas la periode deja verifiee', r.status === 200 && l.amazon_receipt_id === R2 && proche(l.amazon_period_end, fin2), JSON.stringify(l));

  // Un vieux recu expire ne coupe pas un abonnement renouvele
  r = await appel(S, 'POST', '/amazon/verify', { token: tokenA1, body: { userId: U1, receiptIds: [R1] } });
  l = await ligne('a1@example.test');
  check('un vieux recu expire ne coupe pas l\'abonnement renouvele', r.status === 200 && l.amazon_status === 'active' && l.amazon_receipt_id === R2 && r.data.active === true, JSON.stringify(r.data) + JSON.stringify(l));

  // Annulation reelle : le recu qui donne l'acces est annule chez Amazon
  declarer('production', R2, U1, abo({ auto: false, annule: Date.now() - 60000 }));
  await sql("UPDATE paid_emails SET amazon_verified_at = now() - interval '1 hour' WHERE email = 'a1@example.test'");
  r = await appel(S, 'POST', '/amazon/verify', { token: tokenA1, body: { userId: U1, receiptIds: [R2] } });
  l = await ligne('a1@example.test');
  check('annulation / remboursement chez Amazon : acces ferme', r.status === 200 && r.data.active === false && l.amazon_status === 'canceled', JSON.stringify(r.data) + JSON.stringify(l));
  r = await appel(S, 'GET', '/billing/status', { token: tokenA1 });
  check('/billing/status : inactif apres annulation', r.data.active === false && r.data.status === 'inactive', JSON.stringify(r.data));

  // Nouvel abonnement apres annulation (nouveau recu) : acces rouvert
  const R3 = idRecu('R3'); declarer('production', R3, U1, abo({ renouvelle: Date.now() + 30 * JOUR }));
  r = await appel(S, 'POST', '/amazon/verify', { token: tokenA1, body: { userId: U1, receiptIds: [R3] } });
  r = await appel(S, 'GET', '/billing/status', { token: tokenA1 });
  check('re-abonnement (nouveau recu) : acces rouvert', r.data.active === true && r.data.source === 'amazon', JSON.stringify(r.data));

  // --- Delai de grace et expiration
  await sql("UPDATE paid_emails SET amazon_period_end = now() - interval '1 day' WHERE email = 'a1@example.test'");
  r = await appel(S, 'GET', '/billing/status', { token: tokenA1 });
  check('periode finie depuis 1 jour : acces conserve (delai de grace de 3 jours)', r.data.active === true, JSON.stringify(r.data));
  await sql("UPDATE paid_emails SET amazon_period_end = now() - interval '5 days' WHERE email = 'a1@example.test'");
  r = await appel(S, 'GET', '/billing/status', { token: tokenA1 });
  check('periode finie depuis 5 jours sans renouvellement signale : acces ferme', r.data.active === false, JSON.stringify(r.data));
  const R4 = idRecu('R4'); declarer('production', R4, U1, abo({ renouvelle: Date.now() + 30 * JOUR }));
  r = await appel(S, 'POST', '/amazon/verify', { token: tokenA1, body: { userId: U1, receiptIds: [R4] } });
  check('a la reouverture de l\'appli, le recu de renouvellement rouvre l\'acces', r.status === 200 && r.data.active === true, JSON.stringify(r.data));

  // --- Renouvellement automatique coupe : valable jusqu'a la date de fin
  const Ufin = idUser('fin'), Rfin = idRecu('fin'); const dateFin = Date.now() + 9 * JOUR;
  declarer('production', Rfin, Ufin, abo({ auto: false, annule: dateFin }));
  r = await inscrire(S, 'd1@example.test', { userId: Ufin, receiptIds: [Rfin] });
  l = await ligne('d1@example.test');
  check('abonnement resilie mais paye jusqu\'a une date future : inscription acceptee jusqu\'a cette date', r.status === 201 && proche(l.amazon_period_end, dateFin), JSON.stringify(l));

  // --- Stripe et Amazon : deux sources independantes
  await sql("UPDATE paid_emails SET status = 'canceled', stripe_customer_id = 'cus_ancien', verified_at = now() - interval '13 hours' WHERE email = 'a1@example.test'");
  const { isEmailPaid } = require('./routes/billing');
  check('ancien abonnement Stripe resilie : l\'abonne Amazon garde l\'acces', (await isEmailPaid('a1@example.test')) === true, '');
  r = await appel(S, 'GET', '/billing/status', { token: tokenA1 });
  check('... meme resultat via /billing/status', r.data.active === true && r.data.source === 'amazon', JSON.stringify(r.data));

  // --- Aucun lien Stripe dans l'application Amazon
  r = await appel(S, 'POST', '/billing/create-checkout-session', { token: tokenA1, body: {}, ua: UA_AMAZON });
  check('appli Amazon : Stripe checkout refuse (403 USE_AMAZON_IAP)', r.status === 403 && r.data.code === 'USE_AMAZON_IAP', r.status + JSON.stringify(r.data));
  r = await appel(S, 'POST', '/billing/create-portal-session', { token: tokenA1, body: {}, ua: UA_AMAZON });
  check('appli Amazon : portail Stripe refuse (403 USE_AMAZON_IAP)', r.status === 403 && r.data.code === 'USE_AMAZON_IAP', r.status + JSON.stringify(r.data));
  r = await appel(S, 'POST', '/billing/create-checkout-session', { token: tokenA1, body: {} });
  check('site web : le chemin Stripe n\'est pas bloque (ici 500 car Stripe non configure dans ce test)', r.status !== 403, r.status);

  // --- Invitations : un abonne Amazon peut inviter, et ses invites suivent son abonnement
  await sql("UPDATE paid_emails SET amazon_period_end = now() + interval '20 days', amazon_status = 'active', amazon_verified_at = now() WHERE email = 'a1@example.test'");
  r = await appel(S, 'POST', '/link/invite', { token: tokenA1, body: { roleLabel: 'parent' } });
  check('un abonne Amazon peut creer un code d\'invitation', r.status === 201 && !!r.data.code, JSON.stringify(r.data));
  const code = r.data.code;
  r = await inscrire(S, 'e1@example.test', null, { role: 'person', inviteCode: code });
  check('la personne invitee peut creer son compte', r.status === 201, JSON.stringify(r.data));
  const tokenE1 = r.data.token;
  r = await appel(S, 'GET', '/billing/status', { token: tokenE1 });
  check('l\'invitee a acces tant que l\'abonnement Amazon du payeur court', r.data.active === true && r.data.source === 'linked', JSON.stringify(r.data));
  // Meme chose depuis l'appli Fire (code valide : pas de compte libre, acces par le payeur)
  r = await appel(S, 'POST', '/link/invite', { token: tokenA1, body: { roleLabel: 'parent' } });
  const codeFire = r.data.code;
  r = await inscrire(S, 'e2@example.test', null, { role: 'person', inviteCode: codeFire }, UA_AMAZON);
  check('appli Amazon + code d\'invitation valide : 201, abonnement non requis', r.status === 201 && r.data.subscriptionRequired === false, JSON.stringify(r.data));
  r = await appel(S, 'GET', '/billing/status', { token: r.data.token, ua: UA_AMAZON });
  check('... et l\'acces est ouvert par le payeur (source linked)', r.data.active === true && r.data.source === 'linked', JSON.stringify(r.data));
  await sql("UPDATE paid_emails SET amazon_period_end = now() - interval '5 days' WHERE email = 'a1@example.test'");
  r = await appel(S, 'GET', '/billing/status', { token: tokenE1 });
  check('l\'invitee perd l\'acces quand l\'abonnement Amazon du payeur s\'arrete', r.data.active === false, JSON.stringify(r.data));
  await sql("UPDATE paid_emails SET amazon_period_end = now() + interval '20 days' WHERE email = 'a1@example.test'");

  // --- Bac a sable : refuse en production
  const Us = idUser('sb'), Rsb = idRecu('sb');
  declarer('sandbox', Rsb, Us, abo({ test: true }));
  rvsLog.length = 0;
  r = await inscrire(S, 'f1@example.test', { userId: Us, receiptIds: [Rsb] });
  check('mode production : un recu du bac a sable est refuse', r.status === 402, JSON.stringify(r.data));
  check('... et le bac a sable n\'est meme pas interroge', rvsLog.every(p => !p.startsWith('/sandbox')), JSON.stringify(rvsLog));

  // --- Suppression de compte : l'utilisateur est prevenu, le rattachement est libere
  r = await appel(S, 'DELETE', '/account', { token: tokenA1, body: { password: 'motdepasse1' } });
  check('suppression du compte : prevenu que l\'abonnement Amazon n\'est pas resilie automatiquement',
    r.status === 200 && r.data.deleted === true && r.data.amazonSubscriptionActive === true && /Amazon/.test(r.data.message), JSON.stringify(r.data));
  check('... la ligne d\'abonnement est supprimee', !(await ligne('a1@example.test')), '');
  declarer('production', R4, U1, abo({ renouvelle: Date.now() + 30 * JOUR }));
  r = await inscrire(S, 'a4@example.test', { userId: U1, receiptIds: [R4] });
  check('... le compte Amazon est libere : un nouveau compte peut utiliser l\'abonnement en cours', r.status === 201, JSON.stringify(r.data));

  // --- Compte supprime mais jeton encore valide : aucune ligne recree
  r = await appel(S, 'POST', '/amazon/verify', { token: tokenA1, body: { userId: idUser('zz'), receiptIds: [idRecu('zz')] } });
  check('jeton d\'un compte supprime : refuse (401), rien n\'est recree', r.status === 401 && !(await ligne('a1@example.test')), r.status);

  // --- Entrees invalides sur /amazon/verify
  const tokenA4 = (await appel(S, 'POST', '/auth/login', { body: { email: 'a4@example.test', password: 'motdepasse1' } })).data.token;
  for (const [nom, corps] of [['sans userId', { receiptIds: [R1] }], ['sans recu', { userId: U1 }], ['identifiant piege', { userId: 'a/b/c/d/e/f', receiptIds: [R1] }], ['11 recus', { userId: U1, receiptIds: Array.from({ length: 11 }, (_, i) => 'RECU-NUM-' + i) }]]) {
    r = await appel(S, 'POST', '/amazon/verify', { token: tokenA4, body: corps });
    check(`/amazon/verify ${nom} : 400`, r.status === 400 && r.data.code === 'AMAZON_INVALID_REQUEST', r.status + JSON.stringify(r.data));
  }
  // Deuxieme compte Amazon pour un compte deja abonne
  const Ub = idUser('b'), Rb = idRecu('b'); declarer('production', Rb, Ub, abo());
  r = await appel(S, 'POST', '/amazon/verify', { token: tokenA4, body: { userId: Ub, receiptIds: [Rb] } });
  check('compte deja abonne via un autre compte Amazon : 409 AMAZON_OTHER_ACCOUNT', r.status === 409 && r.data.code === 'AMAZON_OTHER_ACCOUNT', r.status + JSON.stringify(r.data));

  // --- Statistiques d'administration non exposees sans jeton
  r = await appel(S, 'GET', '/admin/etat');
  check('/admin/etat reste introuvable sans ADMIN_TOKEN', r.status === 404, r.status);
  await S.stop();

  // ===== 2. Mode "auto" (pendant les essais avec App Tester) ==================
  S = await demarrer({ AMAZON_RVS_MODE: 'auto', ADMIN_TOKEN: 'jeton-admin-de-test' });
  rvsLog.length = 0;
  r = await inscrire(S, 'f2@example.test', { userId: Us, receiptIds: [Rsb] });
  check('mode auto : un recu du bac a sable est accepte', r.status === 201, JSON.stringify(r.data));
  const tokenF2 = r.data.token;
  l = await ligne('f2@example.test');
  check('... enregistre comme achat de test (env sandbox)', l.amazon_env === 'sandbox' && l.amazon_status === 'active', JSON.stringify(l));
  check('... la production est essayee d\'abord, puis le bac a sable', rvsLog.length === 2 && rvsLog[0].startsWith('/version/') && rvsLog[1].startsWith('/sandbox/version/'), JSON.stringify(rvsLog));
  check('... la VRAIE cle n\'est jamais envoyee au bac a sable', !rvsLog[1].includes(SECRET) && rvsLog[1].includes('/developer/developerSecret/'), rvsLog[1]);
  r = await appel(S, 'GET', '/billing/status', { token: tokenF2 });
  check('... acces ouvert pendant les essais', r.data.active === true, JSON.stringify(r.data));
  const adm =await fetch(S.base + '/admin/etat', { headers: { 'X-Admin-Token': 'jeton-admin-de-test' } }).then(x => x.json());
  check('/admin/etat : compte les abonnes Amazon et indique le mode', adm.abonnesAmazon >= 1 && adm.amazon && adm.amazon.mode === 'auto' && adm.amazon.pret === true, JSON.stringify(adm));

  // Panne de la production : pas de bascule vers le bac a sable
  const Rs2 = idRecu('sb2'), Us3 = idUser('sb3');
  declarer('sandbox', Rs2, Us3, abo({ test: true })); declarer('production', Rs2, Us3, null, 500);
  rvsLog.length = 0;
  r = await inscrire(S, 'f3@example.test', { userId: Us3, receiptIds: [Rs2] });
  check('mode auto : production en panne => 503, pas de repli sur le bac a sable', r.status === 503 && rvsLog.every(p => !p.startsWith('/sandbox')), r.status + JSON.stringify(rvsLog));
  await S.stop();

  // ===== 3. Retour en mode production : les acces de test s'eteignent ==========
  S = await demarrer();
  r = await appel(S, 'GET', '/billing/status', { token: tokenF2 });
  check('retour en production : l\'acces obtenu avec le bac a sable s\'eteint tout seul', r.data.active === false, JSON.stringify(r.data));
  await S.stop();

  // ===== 4. Serveur mal configure : cle absente ===============================
  S = await demarrer({ AMAZON_RVS_SECRET: undefined });
  r = await appel(S, 'GET', '/amazon/etat');
  check('sans cle : /amazon/etat annonce pret = false', r.data.pret === false, JSON.stringify(r.data));
  const Rnk = idRecu('nokey'); declarer('production', Rnk, Ux, abo());
  r = await inscrire(S, 'g1@example.test', { userId: Ux, receiptIds: [Rnk] });
  check('sans cle : l\'achat n\'est jamais accorde sur la foi de l\'application (503)', r.status === 503 && !(await compte('g1@example.test')), r.status + JSON.stringify(r.data));
  r = await inscrire(S, 'g2@example.test', null);
  check('sans cle : l\'inscription classique (Stripe/invitation) reste inchangee (402)', r.status === 402, r.status);
  await S.stop();

  // ===== 5. Liste blanche de produits ==========================================
  S = await demarrer({ AMAZON_SKUS: 'spectra_monthly' });
  const Uk = idUser('k'), Rk1 = idRecu('k1'), Rk2 = idRecu('k2');
  declarer('production', Rk1, Uk, abo({ produit: 'autre_produit' }));
  declarer('production', Rk2, Uk, abo({ produit: 'spectra_monthly' }));
  r = await inscrire(S, 'h1@example.test', { userId: Uk, receiptIds: [Rk1] });
  check('AMAZON_SKUS : un autre produit est refuse', r.status === 402, r.status + JSON.stringify(r.data));
  r = await inscrire(S, 'h2@example.test', { userId: Uk, receiptIds: [Rk2] });
  check('AMAZON_SKUS : le bon produit est accepte', r.status === 201, r.status + JSON.stringify(r.data));
  await S.stop();

  // ===== 6. Course : deux inscriptions simultanees avec le meme achat ===========
  S = await demarrer();
  const Uc = idUser('course'), Rc = idRecu('course'); declarer('production', Rc, Uc, abo());
  const [x, y] = await Promise.all([
    inscrire(S, 'i1@example.test', { userId: Uc, receiptIds: [Rc] }),
    inscrire(S, 'i2@example.test', { userId: Uc, receiptIds: [Rc] }),
  ]);
  const statuts = [x.status, y.status].sort();
  const nbComptes = (await sql("SELECT count(*)::int AS n FROM users WHERE email IN ('i1@example.test','i2@example.test')"))[0].n;
  check('deux inscriptions simultanees, meme achat : un seul compte cree', nbComptes === 1 && statuts[0] === 201 && statuts[1] === 409, JSON.stringify([x.status, y.status, nbComptes, x.data, y.data]));
  await S.stop();

  // ===== 7. Amazon trop lent, ou reponse illisible =============================
  S = await demarrer({ AMAZON_RVS_TIMEOUT_MS: '1000' });
  const Ut = idUser('lent'), Rt = idRecu('lent'), Ri = idRecu('illisible');
  declarer('production', Rt, Ut, abo(), null, { delai: 4000 });
  declarer('production', Ri, Ut, null, null, { brut: 'ceci n\'est pas du JSON' });
  const t0 = Date.now();
  r = await inscrire(S, 'j1@example.test', { userId: Ut, receiptIds: [Rt] });
  check('Amazon trop lent (delai depasse) : 503 rapide, rien n\'est accorde',
    r.status === 503 && r.data.code === 'AMAZON_UNAVAILABLE' && Date.now() - t0 < 3500 && !(await compte('j1@example.test')), r.status + ' ' + (Date.now() - t0) + ' ms');
  r = await inscrire(S, 'j2@example.test', { userId: Ut, receiptIds: [Ri] });
  check('reponse illisible d\'Amazon : 503, rien n\'est accorde', r.status === 503 && !(await compte('j2@example.test')), r.status + JSON.stringify(r.data));
  await S.stop();

  {
  // ===== 8. FORMAT DE LA PAGE DU SITE (spectra-amazon.js) =======================
  // La page verifie l'achat AVANT que le compte existe : { receiptId, amazonUserId, email? },
  // sans connexion. Puis l'acheteur cree son compte avec le meme e-mail.
  S = await demarrer();
  const bcrypt = require('bcryptjs');
  const { randomUUID } = require('crypto');
  const SKU_PARENT = 'spectra_abonnement', SKU_MOIS = 'spectra_abonnement_mensuel';
  const aboPage = (opts) => ({ ...abo({ produit: SKU_PARENT, ...opts }), termSku: SKU_MOIS });
  const verifier = (corps, opts = {}) => appel(S, 'POST', '/amazon/verify', { body: corps, ...opts });
  // Compte cree directement en base (sans passer par le paiement) + jeton de connexion.
  const creerCompte = async (email) => {
    await sql("INSERT INTO users (id, email, password_hash, display_name, role) VALUES ($1, $2, $3, 'Essai', 'caregiver')",
      [randomUUID(), email, bcrypt.hashSync('motdepasse1', 10)]);
    const rr = await appel(S, 'POST', '/auth/login', { body: { email, password: 'motdepasse1' } });
    return rr.data.token;
  };
  const vieillir = (email, extra = '') => sql(`UPDATE paid_emails SET amazon_verified_at = now() - interval '13 hours' ${extra} WHERE email = $1`, [email]);

  // --- 8a. Achat avant la creation du compte
  const Up = idUser('page1'), Rp = idRecu('page1');
  declarer('production', Rp, Up, aboPage({ renouvelle: Date.now() + 30 * JOUR }));
  rvsLog.length = 0;
  r = await verifier({ receiptId: Rp, amazonUserId: Up, email: '  Page1@Example.TEST ' });
  check('page : achat verifie AVANT la creation du compte, sans connexion : 200 actif', r.status === 200 && r.data.active === true && r.data.status === 'active', r.status + JSON.stringify(r.data));
  check('... e-mail normalise (minuscules, sans espaces), renvoye en clair, pas "deja lie"',
    r.data.email === 'page1@example.test' && r.data.alreadyLinkedToOtherEmail === false, JSON.stringify(r.data));
  check('... le recu est a confirmer a Amazon', JSON.stringify(r.data.receiptsToConfirm) === JSON.stringify([Rp]), JSON.stringify(r.data));
  check('... aucun compte Spectra pour cet e-mail : accountExists = false (la page propose "creer un compte")', r.data.accountExists === false, JSON.stringify(r.data));
  check('... Amazon interroge avec les bons identifiants',
    rvsLog.length === 1 && rvsLog[0] === `/version/1.0/verifyReceiptId/developer/${SECRET}/user/${Up}/receiptId/${Rp}`, JSON.stringify(rvsLog));
  check('... aucun compte cree par la verification', !(await compte('page1@example.test')), '');
  l = await ligne('page1@example.test');
  check('... ligne paid_emails : Amazon actif, colonne Stripe a "none"',
    l && l.amazon_user_id === Up && l.amazon_status === 'active' && l.status === 'none' && l.amazon_receipt_id === Rp, JSON.stringify(l));
  r = await inscrire(S, 'page1@example.test', null);
  check('page : creation du compte avec cet e-mail (aucune preuve dans la requete) : 201', r.status === 201 && !!r.data.token, r.status + JSON.stringify(r.data));
  const tokenP1 = r.data.token;
  r = await appel(S, 'GET', '/billing/status', { token: tokenP1 });
  check('... /billing/status du nouveau compte : acces ouvert, source amazon', r.data.active === true && r.data.source === 'amazon', JSON.stringify(r.data));
  r = await inscrire(S, 'PAGE1@example.test', null);
  check('... meme e-mail en majuscules : "compte deja existant" (409), pas un doublon', r.status === 409, r.status + JSON.stringify(r.data));

  rvsLog.length = 0;
  r = await verifier({ receiptId: Rp, amazonUserId: Up, email: 'page1@example.test' });
  check('page : meme achat verifie < 10 min plus tot : memoire, Amazon non interroge', r.status === 200 && r.data.cached === true && r.data.active === true && rvsLog.length === 0, JSON.stringify(r.data) + rvsLog.length);
  check('... le compte existe maintenant : accountExists = true (la page propose "se connecter")', r.data.accountExists === true, JSON.stringify(r.data));

  // --- 8b. Donnees refusees
  rvsLog.length = 0;
  const Un = idUser('neuf'), Rn = idRecu('neuf'); declarer('production', Rn, Un, aboPage());
  r = await verifier({ receiptId: Rn, amazonUserId: Un });
  check('page : aucun e-mail connu (ni connexion, ni saisie, ni lien existant) : 400 EMAIL_REQUIRED', r.status === 400 && r.data.code === 'EMAIL_REQUIRED' && r.data.active === false, r.status + JSON.stringify(r.data));
  check('... Amazon n\'est meme pas interroge, rien n\'est cree', rvsLog.length === 0 && !(await ligne('neuf@example.test')), JSON.stringify(rvsLog));
  for (const [nom, corps] of [
    ['sans identifiant Amazon', { receiptId: Rn, email: 'x1@example.test' }],
    ['sans recu', { amazonUserId: Un, email: 'x1@example.test' }],
    ['identifiant piege', { receiptId: Rn, amazonUserId: 'mauvais/id', email: 'x1@example.test' }],
    ['recu piege', { receiptId: 'abc/../../x', amazonUserId: Un, email: 'x1@example.test' }],
    ['e-mail invalide', { receiptId: Rn, amazonUserId: Un, email: 'pas-un-email' }],
    ['e-mail de type objet', { receiptId: Rn, amazonUserId: Un, email: { a: 1 } }],
    ['e-mail trop long', { receiptId: Rn, amazonUserId: Un, email: 'a'.repeat(300) + '@example.test' }],
    ['corps vide', {}],
  ]) {
    r = await verifier(corps);
    check(`page : ${nom} : 400 AMAZON_INVALID_REQUEST`, r.status === 400 && r.data.code === 'AMAZON_INVALID_REQUEST', r.status + JSON.stringify(r.data));
  }
  check('... aucune de ces demandes n\'a interroge Amazon', rvsLog.length === 0, JSON.stringify(rvsLog));

  // Recus que le serveur ne doit pas accepter
  r = await verifier({ receiptId: idRecu('inconnu-p'), amazonUserId: Un, email: 'inconnu@example.test' });
  check('page : recu inconnu d\'Amazon : 400 AMAZON_RECEIPT_INVALID, aucune ligne creee',
    r.status === 400 && r.data.code === 'AMAZON_RECEIPT_INVALID' && !(await ligne('inconnu@example.test')), r.status + JSON.stringify(r.data));
  r = await inscrire(S, 'inconnu@example.test', null);
  check('... et l\'inscription avec cet e-mail reste refusee (402)', r.status === 402, r.status);
  const Rannp = idRecu('annule-p'); declarer('production', Rannp, Un, aboPage({ auto: false, annule: Date.now() - JOUR }));
  r = await verifier({ receiptId: Rannp, amazonUserId: Un, email: 'annule@example.test' });
  check('page : abonnement deja termine : 200 inactif (AMAZON_RECEIPT_CANCELED), aucune ligne creee',
    r.status === 200 && r.data.active === false && r.data.code === 'AMAZON_RECEIPT_CANCELED' && !(await ligne('annule@example.test')), r.status + JSON.stringify(r.data));
  const Rcp = idRecu('conso-p'); declarer('production', Rcp, Un, aboPage({ type: 'CONSUMABLE' }));
  r = await verifier({ receiptId: Rcp, amazonUserId: Un, email: 'conso@example.test' });
  check('page : achat qui n\'est pas un abonnement : refuse, aucune ligne creee', r.status === 400 && !(await ligne('conso@example.test')), r.status + JSON.stringify(r.data));
  const Rpn = idRecu('panne-p'); declarer('production', Rpn, Un, aboPage());
  panne = 500;
  r = await verifier({ receiptId: Rpn, amazonUserId: Un, email: 'panne@example.test' });
  check('page : Amazon en panne : 503 AMAZON_UNAVAILABLE + Retry-After, rien n\'est accorde',
    r.status === 503 && r.data.code === 'AMAZON_UNAVAILABLE' && !!r.headers.get('retry-after') && !(await ligne('panne@example.test')), r.status + JSON.stringify(r.data));
  panne = 496;
  r = await verifier({ receiptId: Rpn, amazonUserId: Un, email: 'panne@example.test' });
  check('page : cle partagee refusee : 503, sans detail technique ni cle dans la reponse', r.status === 503 && !JSON.stringify(r.data).includes(SECRET), JSON.stringify(r.data));
  panne = null;
  r = await verifier({ receiptId: Rpn, amazonUserId: Un, email: 'panne@example.test' });
  check('page : Amazon revenu : la meme demande reussit (rien n\'etait perdu)', r.status === 200 && r.data.active === true, r.status + JSON.stringify(r.data));

  // --- 8c. Un compte Amazon <-> un seul e-mail Spectra
  r = await verifier({ receiptId: Rn, amazonUserId: Un, email: 'autre-mail@example.test' });
  check('page : meme compte Amazon, autre e-mail saisi : 200, "deja lie a un autre e-mail", e-mail MASQUE',
    r.status === 200 && r.data.alreadyLinkedToOtherEmail === true && r.data.email === 'p***@example.test' && r.data.active === true, r.status + JSON.stringify(r.data));
  check('... l\'e-mail deja lie n\'apparait jamais en clair', !JSON.stringify(r.data).includes('panne@example.test'), JSON.stringify(r.data));
  check('... aucune ligne creee pour l\'autre e-mail', !(await ligne('autre-mail@example.test')), '');
  r = await inscrire(S, 'autre-mail@example.test', null);
  check('... et l\'autre e-mail ne peut pas creer de compte avec cet abonnement (402)', r.status === 402, r.status);
  r = await verifier({ receiptId: Rn, amazonUserId: Un });
  check('page : restauration sur une nouvelle tablette (aucun e-mail connu) : retrouve le compte lie, e-mail masque',
    r.status === 200 && r.data.alreadyLinkedToOtherEmail === true && r.data.email === 'p***@example.test' && r.data.active === true, r.status + JSON.stringify(r.data));
  check('... compte lie sans compte Spectra : accountExists = false', r.data.accountExists === false, JSON.stringify(r.data));
  await creerCompte('panne@example.test');
  r = await verifier({ receiptId: Rn, amazonUserId: Un });
  check('page : restauration, le compte Spectra lie existe maintenant : accountExists = true (e-mail toujours masque)',
    r.status === 200 && r.data.accountExists === true && r.data.alreadyLinkedToOtherEmail === true && r.data.email === 'p***@example.test', r.status + JSON.stringify(r.data));
  r = await verifier({ receiptId: Rn, amazonUserId: Un, email: 'panne@example.test' });
  check('page : meme compte Amazon, e-mail identique a celui deja lie : pas de "deja lie", e-mail en clair',
    r.status === 200 && r.data.alreadyLinkedToOtherEmail === false && r.data.email === 'panne@example.test', r.status + JSON.stringify(r.data));

  // Un e-mail deja abonne via un autre compte Amazon n'est pas ecrase
  const Ux2 = idUser('intrus'), Rx2 = idRecu('intrus'); declarer('production', Rx2, Ux2, aboPage());
  r = await verifier({ receiptId: Rx2, amazonUserId: Ux2, email: 'page1@example.test' });
  check('page : e-mail deja abonne via un autre compte Amazon : 409 AMAZON_OTHER_ACCOUNT, rien n\'est ecrase',
    r.status === 409 && r.data.code === 'AMAZON_OTHER_ACCOUNT', r.status + JSON.stringify(r.data));
  l = await ligne('page1@example.test');
  check('... la liaison d\'origine est intacte', l.amazon_user_id === Up && l.amazon_receipt_id === Rp, JSON.stringify(l));

  // Une fausse demande ne peut ni annuler ni modifier l'abonnement d'un autre
  r = await verifier({ receiptId: idRecu('faux'), amazonUserId: idUser('pirate'), email: 'page1@example.test' });
  l = await ligne('page1@example.test');
  check('page : recu invente avec l\'e-mail d\'un abonne : refuse, son abonnement reste actif',
    r.status === 400 && l.amazon_status === 'active' && l.amazon_user_id === Up, r.status + JSON.stringify(l));

  // Deux demandes simultanees : un seul e-mail obtient la liaison
  // Reponse d'Amazon retardee : les deux demandes se rejoignent vraiment au moment d'enregistrer.
  const Ucp = idUser('courseP'), Rcp2 = idRecu('courseP'); declarer('production', Rcp2, Ucp, aboPage(), null, { delai: 300 });
  const [c1, c2] = await Promise.all([
    verifier({ receiptId: Rcp2, amazonUserId: Ucp, email: 'coursep1@example.test' }),
    verifier({ receiptId: Rcp2, amazonUserId: Ucp, email: 'coursep2@example.test' }),
  ]);
  const nbLignes = (await sql('SELECT count(*)::int AS n FROM paid_emails WHERE amazon_user_id = $1', [Ucp]))[0].n;
  check('page : deux demandes simultanees pour le meme compte Amazon : une seule liaison, deux reponses 200, une seule "deja lie"',
    nbLignes === 1 && c1.status === 200 && c2.status === 200 && [c1, c2].filter(x => x.data.alreadyLinkedToOtherEmail).length === 1,
    JSON.stringify([nbLignes, c1.status, c2.status, c1.data, c2.data]));

  // --- 8d. Connexion facultative : le jeton prime, un jeton perime est ignore
  const tokenC = await creerCompte('connecte@example.test');
  const Uco = idUser('connecte'), Rco = idRecu('connecte'); declarer('production', Rco, Uco, aboPage());
  r = await verifier({ receiptId: Rco, amazonUserId: Uco, email: 'ignore-moi@example.test' }, { token: tokenC });
  check('page : compte connecte : l\'abonnement va a SON e-mail, l\'e-mail du corps est ignore',
    r.status === 200 && r.data.email === 'connecte@example.test' && !(await ligne('ignore-moi@example.test')) && (await ligne('connecte@example.test')).amazon_user_id === Uco, r.status + JSON.stringify(r.data));
  r = await appel(S, 'GET', '/billing/status', { token: tokenC });
  check('... /billing/status : acces ouvert, source amazon', r.data.active === true && r.data.source === 'amazon', JSON.stringify(r.data));
  const Uje = idUser('jetonperime'), Rje = idRecu('jetonperime'); declarer('production', Rje, Uje, aboPage());
  r = await verifier({ receiptId: Rje, amazonUserId: Uje, email: 'jeton-perime@example.test' }, { token: 'abc.def.ghi' });
  check('page : jeton invalide ou perime : ignore, la verification se fait comme pour un visiteur (200)',
    r.status === 200 && r.data.email === 'jeton-perime@example.test', r.status + JSON.stringify(r.data));
  const tokenSup = await creerCompte('supprime@example.test');
  await sql("DELETE FROM users WHERE email = 'supprime@example.test'");
  const Usu = idUser('supprime'), Rsu = idRecu('supprime'); declarer('production', Rsu, Usu, aboPage());
  r = await verifier({ receiptId: Rsu, amazonUserId: Usu, email: 'supprime-bis@example.test' }, { token: tokenSup });
  check('page : jeton d\'un compte supprime : ignore (pas d\'erreur), e-mail saisi utilise',
    r.status === 200 && r.data.email === 'supprime-bis@example.test', r.status + JSON.stringify(r.data));
  check('... et le compte supprime n\'a pas ete recree', !(await compte('supprime@example.test')) && !(await ligne('supprime@example.test')), '');
  r = await appel(S, 'POST', '/amazon/verify', { body: { userId: U1, receiptId: R1 } });
  check('ancien format { userId, receiptId } sans connexion : toujours 401', r.status === 401, r.status);

  // --- 8e. Resiliation signalee par la page (recu annule, sans e-mail ni connexion)
  const Ucn = idUser('resilie'), Rcn = idRecu('resilie'); declarer('production', Rcn, Ucn, aboPage());
  await verifier({ receiptId: Rcn, amazonUserId: Ucn, email: 'resilie-p@example.test' });
  const tokenRes = await creerCompte('resilie-p@example.test');
  r = await appel(S, 'GET', '/billing/status', { token: tokenRes });
  check('page : abonne Amazon avant resiliation : acces ouvert', r.data.active === true, JSON.stringify(r.data));
  declarer('production', Rcn, Ucn, aboPage({ auto: false, annule: Date.now() - 1000 }));
  await vieillir('resilie-p@example.test'); // le cache de 10 minutes ne doit pas masquer l'annulation
  await sql("UPDATE paid_emails SET amazon_verified_at = now() - interval '1 hour' WHERE email = 'resilie-p@example.test'");
  r = await verifier({ receiptId: Rcn, amazonUserId: Ucn });
  check('page : recu annule signale par l\'application : 200 inactif', r.status === 200 && r.data.active === false && r.data.code === 'AMAZON_RECEIPT_CANCELED', r.status + JSON.stringify(r.data));
  l = await ligne('resilie-p@example.test');
  check('... abonnement marque "canceled" en base', l.amazon_status === 'canceled', JSON.stringify(l));
  r = await appel(S, 'GET', '/billing/status', { token: tokenRes });
  check('... /billing/status : acces ferme', r.data.active === false, JSON.stringify(r.data));

  // --- 8f. Renouvellement mensuel : le serveur revérifie SEUL (Amazon ne renvoie plus le recu)
  const Ur = idUser('renouv'), Rr = idRecu('renouv');
  declarer('production', Rr, Ur, aboPage({ renouvelle: Date.now() + 30 * JOUR }));
  await verifier({ receiptId: Rr, amazonUserId: Ur, email: 'renouv@example.test' });
  const tokenR = await creerCompte('renouv@example.test');
  await sql("UPDATE paid_emails SET amazon_period_end = now() - interval '10 days', amazon_verified_at = now() - interval '13 hours' WHERE email = 'renouv@example.test'");
  declarer('production', Rr, Ur, aboPage({ renouvelle: Date.now() + 25 * JOUR }));
  rvsLog.length = 0;
  r = await appel(S, 'GET', '/billing/status', { token: tokenR });
  check('renouvellement : periode terminee depuis 10 jours mais Amazon a renouvele : acces retrouve, sans que l\'appli renvoie le recu',
    r.data.active === true && r.data.source === 'amazon' && rvsLog.length === 1, JSON.stringify(r.data) + rvsLog.length);
  l = await ligne('renouv@example.test');
  check('... fin de periode mise a jour d\'apres Amazon', proche(l.amazon_period_end, Date.now() + 25 * JOUR, 5000) && l.amazon_status === 'active', JSON.stringify(l));
  rvsLog.length = 0;
  r = await appel(S, 'GET', '/billing/status', { token: tokenR });
  check('... controle suivant (< 12 h) : Amazon non interroge', r.data.active === true && rvsLog.length === 0, rvsLog.length);

  // Renouvellement automatique coupe par le client : acces jusqu'a la date indiquee
  await vieillir('renouv@example.test');
  declarer('production', Rr, Ur, aboPage({ auto: false, annule: Date.now() + 10 * JOUR }));
  r = await appel(S, 'GET', '/billing/status', { token: tokenR });
  l = await ligne('renouv@example.test');
  check('renouvellement coupe par le client (fin dans 10 jours) : acces conserve jusqu\'a cette date',
    r.data.active === true && proche(l.amazon_period_end, Date.now() + 10 * JOUR, 5000), JSON.stringify(r.data) + JSON.stringify(l));
  // Resiliation / remboursement constates au controle suivant
  await vieillir('renouv@example.test');
  declarer('production', Rr, Ur, aboPage({ auto: false, annule: Date.now() - 1000 }));
  r = await appel(S, 'GET', '/billing/status', { token: tokenR });
  l = await ligne('renouv@example.test');
  check('resiliation constatee au controle suivant : acces ferme, abonnement "canceled"', r.data.active === false && l.amazon_status === 'canceled', JSON.stringify(r.data) + JSON.stringify(l));
  // Une fois resilie, plus aucun controle inutile
  rvsLog.length = 0;
  await sql("UPDATE paid_emails SET amazon_verified_at = now() - interval '30 hours' WHERE email = 'renouv@example.test'");
  await appel(S, 'GET', '/billing/status', { token: tokenR });
  check('abonnement resilie : Amazon n\'est plus interroge a chaque ouverture', rvsLog.length === 0, rvsLog.length);

  // Panne d'Amazon pendant le controle : on ne retire rien dans la periode payee
  const Upa = idUser('panneR'), Rpa = idRecu('panneR');
  declarer('production', Rpa, Upa, aboPage({ renouvelle: Date.now() + 30 * JOUR }));
  await verifier({ receiptId: Rpa, amazonUserId: Upa, email: 'panne-r@example.test' });
  const tokenPa = await creerCompte('panne-r@example.test');
  await vieillir('panne-r@example.test');
  panne = 500; rvsLog.length = 0;
  r = await appel(S, 'GET', '/billing/status', { token: tokenPa });
  check('controle pendant une panne d\'Amazon : l\'abonne dans sa periode payee garde l\'acces', r.status === 200 && r.data.active === true && rvsLog.length >= 1, r.status + JSON.stringify(r.data));
  l = await ligne('panne-r@example.test');
  check('... rien n\'a ete modifie en base', l.amazon_status === 'active' && proche(l.amazon_period_end, Date.now() + 30 * JOUR, 5000), JSON.stringify(l));
  check('... et la panne n\'est pas notee comme un controle reussi (le prochain essai reste du)', Date.now() - new Date(l.amazon_verified_at).getTime() > 12 * 3600 * 1000, l.amazon_verified_at);
  rvsLog.length = 0;
  r = await appel(S, 'GET', '/billing/status', { token: tokenPa });
  check('... pas d\'insistance : aucune nouvelle requete a Amazon pendant la minute qui suit', r.data.active === true && rvsLog.length === 0, rvsLog.length);
  panne = null;
  // Panne ET periode (avec delai de grace) depassee : acces ferme, jamais accorde sur la foi de personne
  const Upb = idUser('panneS'), Rpb = idRecu('panneS');
  declarer('production', Rpb, Upb, aboPage({ renouvelle: Date.now() + 30 * JOUR }));
  await verifier({ receiptId: Rpb, amazonUserId: Upb, email: 'panne-s@example.test' });
  const tokenPb = await creerCompte('panne-s@example.test');
  await sql("UPDATE paid_emails SET amazon_period_end = now() - interval '10 days', amazon_verified_at = now() - interval '13 hours' WHERE email = 'panne-s@example.test'");
  panne = 500;
  r = await appel(S, 'GET', '/billing/status', { token: tokenPb });
  check('panne d\'Amazon et periode (avec grace) depassee : acces ferme', r.status === 200 && r.data.active === false, r.status + JSON.stringify(r.data));
  panne = null;

  // Achat du bac a sable en production : ni controle, ni acces
  const Usb = idUser('sbprod'), Rsb = idRecu('sbprod');
  await sql(`INSERT INTO paid_emails (email, status, amazon_user_id, amazon_receipt_id, amazon_status, amazon_period_end, amazon_verified_at, amazon_env)
             VALUES ('sb-prod@example.test', 'none', $1, $2, 'active', now() + interval '30 days', now() - interval '13 hours', 'sandbox')`, [Usb, Rsb]);
  const tokenSb = await creerCompte('sb-prod@example.test');
  rvsLog.length = 0;
  r = await appel(S, 'GET', '/billing/status', { token: tokenSb });
  check('ligne du bac a sable en mode production : acces ferme, Amazon non interroge', r.data.active === false && rvsLog.length === 0, JSON.stringify(r.data) + rvsLog.length);

  // L'inscription profite aussi de la revérification
  const Uin = idUser('inscrip'), Rin = idRecu('inscrip');
  declarer('production', Rin, Uin, aboPage({ renouvelle: Date.now() + 30 * JOUR }));
  await verifier({ receiptId: Rin, amazonUserId: Uin, email: 'inscrip@example.test' });
  await sql("UPDATE paid_emails SET amazon_period_end = now() - interval '10 days', amazon_verified_at = now() - interval '13 hours' WHERE email = 'inscrip@example.test'");
  declarer('production', Rin, Uin, aboPage({ renouvelle: Date.now() + 28 * JOUR }));
  r = await inscrire(S, 'inscrip@example.test', null);
  check('inscription apres un achat dont la periode paraissait terminee mais renouvelee chez Amazon : 201', r.status === 201, r.status + JSON.stringify(r.data));

  // Comptes lies : l'acces de l'invite suit l'abonnement Amazon du payeur, meme s'il n'ouvre pas l'appli
  const Uli = idUser('payeur'), Rli = idRecu('payeur');
  declarer('production', Rli, Uli, aboPage({ renouvelle: Date.now() + 30 * JOUR }));
  await verifier({ receiptId: Rli, amazonUserId: Uli, email: 'payeur@example.test' });
  await creerCompte('payeur@example.test');
  const tokenInv = await creerCompte('invite@example.test');
  const idPayeur = (await compte('payeur@example.test')).id, idInvite = (await compte('invite@example.test')).id;
  await sql("INSERT INTO links (id, person_id, caregiver_id, role_label) VALUES ($1, $2, $3, '')", [randomUUID(), idInvite, idPayeur]);
  r = await appel(S, 'GET', '/billing/status', { token: tokenInv });
  check('compte lie a un payeur Amazon : acces ouvert (source linked)', r.data.active === true && r.data.source === 'linked', JSON.stringify(r.data));
  await sql("UPDATE paid_emails SET amazon_period_end = now() - interval '10 days', amazon_verified_at = now() - interval '13 hours' WHERE email = 'payeur@example.test'");
  declarer('production', Rli, Uli, aboPage({ renouvelle: Date.now() + 27 * JOUR }));
  r = await appel(S, 'GET', '/billing/status', { token: tokenInv });
  check('... le payeur n\'ouvre pas l\'appli, sa periode a ete renouvelee chez Amazon : l\'acces du compte lie continue',
    r.data.active === true && r.data.source === 'linked', JSON.stringify(r.data));
  // Compte cree avec un code d'invitation : le payeur est designe par l'e-mail du code
  const Usp = idUser('sponsor'), Rsp = idRecu('sponsor');
  declarer('production', Rsp, Usp, aboPage({ renouvelle: Date.now() + 30 * JOUR }));
  await verifier({ receiptId: Rsp, amazonUserId: Usp, email: 'sponsor@example.test' });
  const tokenCode = await creerCompte('invite-code@example.test');
  await sql("INSERT INTO invite_codes (code, source_email, expires_at) VALUES ('CODE-SPONSOR-1', 'sponsor@example.test', now() + interval '7 days')");
  await sql("UPDATE users SET invited_via = 'CODE-SPONSOR-1' WHERE email = 'invite-code@example.test'");
  r = await appel(S, 'GET', '/billing/status', { token: tokenCode });
  check('compte cree avec le code d\'un payeur Amazon : acces ouvert (source linked)', r.data.active === true && r.data.source === 'linked', JSON.stringify(r.data));
  await sql("UPDATE paid_emails SET amazon_period_end = now() - interval '10 days', amazon_verified_at = now() - interval '13 hours' WHERE email = 'sponsor@example.test'");
  declarer('production', Rsp, Usp, aboPage({ renouvelle: Date.now() + 26 * JOUR }));
  r = await appel(S, 'GET', '/billing/status', { token: tokenCode });
  check('... le payeur (code d\'invitation) a ete renouvele chez Amazon sans ouvrir l\'appli : l\'acces continue',
    r.data.active === true && r.data.source === 'linked', JSON.stringify(r.data));
  await sql("UPDATE paid_emails SET amazon_verified_at = now() - interval '13 hours' WHERE email = 'sponsor@example.test'");
  declarer('production', Rsp, Usp, aboPage({ auto: false, annule: Date.now() - 1000 }));
  r = await appel(S, 'GET', '/billing/status', { token: tokenCode });
  check('... et si le payeur resilie : l\'acces du compte invite se ferme', r.data.active === false, JSON.stringify(r.data));
  await S.stop();
  }

  rvs.close();
  console.log(results.join('\n'));
  console.log(`\n${pass} tests reussis, ${fail} echec(s).`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error('ERREUR DU TEST :', e);
  try { rvs.close(); await pool.end(); } catch (_) {}
  process.exit(1);
});
