// Test de bout en bout du backend Spectra, sur une vraie base PostgreSQL.
// Lancer : node test-smoke.js  (le serveur doit ecouter sur $BASE)
const jwt = require('jsonwebtoken');
const BASE = process.env.BASE || 'http://localhost:3000';
const SECRET = process.env.JWT_SECRET;
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail) {
  ok ? pass++ : fail++;
  results.push(`${ok ? 'OK  ' : 'ECHEC'}  ${name}${ok ? '' : '  -> ' + detail}`);
}
async function call(method, path, { token, body } = {}) {
  const r = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  let data = null;
  const txt = await r.text();
  try { data = JSON.parse(txt); } catch { data = txt; }
  return { status: r.status, data };
}

(async () => {
  const payeur = 'payeur@example.test';
  const invite = 'invitee@example.test';

  // 1 - sante
  let r = await call('GET', '/health');
  check('health repond 200 et base accessible', r.status === 200 && r.data.ok, JSON.stringify(r.data));

  // 2 - inscription sans paiement refusee
  r = await call('POST', '/auth/register', { body: { email: payeur, password: 'motdepasse1', role: 'caregiver' } });
  check('inscription sans paiement refusee (402)', r.status === 402, r.status);

  // 3 - paiement enregistre puis inscription
  await pool.query("INSERT INTO paid_emails (email, stripe_customer_id, status) VALUES ($1,'cus_test','active') ON CONFLICT (email) DO UPDATE SET status='active'", [payeur]);
  r = await call('POST', '/auth/register', { body: { email: payeur, password: 'motdepasse1', role: 'caregiver', displayName: 'Payeur' } });
  check('inscription apres paiement (201)', r.status === 201 && !!r.data.token, JSON.stringify(r.data));
  const tokenPayeur = r.data.token;

  // 4 - connexion
  r = await call('POST', '/auth/login', { body: { email: payeur, password: 'motdepasse1' } });
  check('connexion (200)', r.status === 200 && !!r.data.token, r.status);

  // 5 - /auth/me
  r = await call('GET', '/auth/me', { token: tokenPayeur });
  check('/auth/me renvoie le compte', r.status === 200 && r.data.user.email === payeur, JSON.stringify(r.data));

  // 6 - A1 : un jeton "manage" ne doit pas ouvrir de session ni faire planter
  const jetonManage = jwt.sign({ cus: 'cus_test', kind: 'manage' }, SECRET, { expiresIn: '1d' });
  r = await call('GET', '/billing/status', { token: jetonManage });
  check('A1 jeton "manage" rejete en 401 (plus de plantage)', r.status === 401, r.status);
  r = await call('GET', '/health');
  check('A1 le serveur est toujours vivant apres la tentative', r.status === 200, r.status);

  // 7 - invitation
  r = await call('POST', '/link/invite', { token: tokenPayeur, body: { roleLabel: 'parent' } });
  check('creation d\'un code d\'invitation (201)', r.status === 201 && !!r.data.code, JSON.stringify(r.data));
  const code = r.data.code;

  // 8 - inscription de la personne invitee
  r = await call('POST', '/auth/register', { body: { email: invite, password: 'motdepasse2', role: 'person', inviteCode: code } });
  check('inscription via code d\'invitation (201)', r.status === 201, JSON.stringify(r.data));
  const tokenInvite = r.data.token;

  // 9 - acces de l'invitee tant que le payeur paie
  r = await call('GET', '/billing/status', { token: tokenInvite });
  check('l\'invitee a acces pendant l\'abonnement', r.status === 200 && r.data.active === true, JSON.stringify(r.data));

  // 10 - B1 : resiliation du payeur -> l'invitee perd l'acces
  await pool.query("UPDATE paid_emails SET status='canceled' WHERE email=$1", [payeur]);
  r = await call('GET', '/billing/status', { token: tokenInvite });
  check('B1 l\'invitee perd l\'acces apres resiliation du payeur', r.data.active === false, JSON.stringify(r.data));
  r = await call('GET', '/billing/status', { token: tokenPayeur });
  check('B1 le payeur aussi perd l\'acces', r.data.active === false, JSON.stringify(r.data));
  await pool.query("UPDATE paid_emails SET status='active' WHERE email=$1", [payeur]);

  // 11 - cloisonnement prive / partage
  const { rows: [p] } = await pool.query('SELECT id FROM users WHERE email=$1', [invite]);
  r = await call('POST', '/sync/journal', { token: tokenInvite, body: { value: { texte: 'prive' } } });
  check('la personne ecrit une donnee privee', r.status === 200, JSON.stringify(r.data));
  r = await call('GET', `/sync/journal?personId=${p.id}`, { token: tokenPayeur });
  check('l\'aidant ne peut PAS lire les donnees privees (403)', r.status === 403, r.status);
  r = await call('POST', '/sync/agenda', { token: tokenInvite, body: { value: { texte: 'partage' }, shared: true } });
  check('la personne ecrit une donnee partagee', r.status === 200, JSON.stringify(r.data));
  r = await call('GET', `/sync/agenda?shared=1&personId=${p.id}`, { token: tokenPayeur });
  check('l\'aidant lit bien la donnee partagee', r.status === 200 && r.data.value.texte === 'partage', JSON.stringify(r.data));
  r = await call('POST', '/sync/agenda', { token: tokenPayeur, body: { value: { texte: 'ecrit par l aidant' }, shared: true, personId: p.id } });
  check('l\'aidant ecrit dans l\'espace partage', r.status === 200, JSON.stringify(r.data));

  // 12 - B3 : mot de passe oublie
  r = await call('POST', '/auth/forgot', { body: { email: 'inconnu@example.test' } });
  check('B3 /auth/forgot ne revele pas si le compte existe', r.status === 200 && r.data.ok === true, JSON.stringify(r.data));
  const { rows: [u] } = await pool.query('SELECT id, password_hash FROM users WHERE email=$1', [invite]);
  const jetonReset = jwt.sign({ sub: u.id, kind: 'reset' }, SECRET + u.password_hash, { expiresIn: '1h' });
  r = await call('POST', '/auth/reset', { body: { token: jetonReset, password: 'nouveaumotdepasse' } });
  check('B3 reinitialisation acceptee', r.status === 200 && r.data.ok === true, JSON.stringify(r.data));
  r = await call('POST', '/auth/login', { body: { email: invite, password: 'nouveaumotdepasse' } });
  check('B3 connexion avec le nouveau mot de passe', r.status === 200, r.status);
  r = await call('POST', '/auth/reset', { body: { token: jetonReset, password: 'encoreunautre' } });
  check('B3 le lien de reinitialisation ne resert pas', r.status === 400, r.status);

  // 13 - B4 : suppression de compte malgre l'ecriture croisee dans kv_store
  r = await call('DELETE', '/account', { token: tokenPayeur, body: { password: 'mauvais' } });
  check('B4 suppression refusee sans le bon mot de passe', r.status === 401, r.status);
  r = await call('GET', '/account/export', { token: tokenPayeur });
  check('B4 export des donnees disponible', r.status === 200 && !!r.data.compte, JSON.stringify(r.data).slice(0, 120));
  r = await call('DELETE', '/account', { token: tokenPayeur, body: { password: 'motdepasse1' } });
  check('B4 suppression du compte aidant (cle etrangere kv_store corrigee)', r.status === 200 && r.data.deleted, JSON.stringify(r.data));
  const { rows: reste } = await pool.query('SELECT 1 FROM users WHERE email=$1', [payeur]);
  check('B4 le compte a bien disparu', reste.length === 0, reste.length);
  const { rows: [kv] } = await pool.query('SELECT updated_by FROM kv_store WHERE owner_id=$1 AND key=$2 AND shared=1', [p.id, 'agenda']);
  check('B4 la donnee partagee survit, updated_by passe a NULL', kv && kv.updated_by === null, JSON.stringify(kv));

  // 14 - divers
  r = await call('GET', '/route-qui-nexiste-pas');
  check('route inconnue -> 404 JSON', r.status === 404, r.status);
  r = await call('GET', '/billing/status');
  check('route protegee sans jeton -> 401', r.status === 401, r.status);

  console.log(results.join('\n'));
  console.log(`\n${pass} tests reussis, ${fail} echec(s).`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})();
