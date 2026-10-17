// Test des comptes de test des relecteurs d'Amazon (reviewers.js).
//
// Il lance LUI-MEME de vrais serveurs Spectra sur une vraie base PostgreSQL.
// Lancer :  DATABASE_URL=postgres://... JWT_SECRET=... node test-relecteurs.js
// (utilisez une base de TEST.)

const { spawn } = require('child_process');
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET || 'test-secret-0123456789abcdef0123456789abcdef';
if (!DATABASE_URL) { console.error('DATABASE_URL manquante.'); process.exit(2); }

const pool = new Pool({ connectionString: DATABASE_URL });
const sql = async (q, p) => (await pool.query(q, p)).rows;

const E1 = 'relecteur-amazon-1@example.com';
const E2 = 'relecteur-amazon-2@example.com';
const MDP1 = 'MotDePasseUn2026';
const MDP2 = 'MotDePasseDeux2026';

let pass = 0, fail = 0;
const results = [];
function check(nom, ok, detail) {
  ok ? pass++ : fail++;
  results.push(`${ok ? 'OK  ' : 'ECHEC'}  ${nom}${ok ? '' : '  -> ' + detail}`);
}
const pause = (ms) => new Promise(r => setTimeout(r, ms));

const lances = [];   // tous les serveurs lances : arretes a la fin, meme en cas d'erreur du test
let portSuivant = 3090;
function demarrer(envSupp = {}) {
  return new Promise((resolve, reject) => {
    const port = portSuivant++;
    const env = {
      ...process.env, PORT: String(port), DATABASE_URL, JWT_SECRET,
      DISABLE_RATE_LIMIT: '1', KEEPALIVE: '0',
      ...envSupp,
    };
    for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
    const proc = spawn('node', ['server.js'], { cwd: __dirname, env, stdio: ['ignore', 'pipe', 'pipe'] });
    lances.push(proc);
    let journal = '';
    proc.stdout.on('data', d => { journal += d; });
    proc.stderr.on('data', d => { journal += d; });
    const base = `http://127.0.0.1:${port}`;
    const debut = Date.now();
    (async function attendre() {
      try { const r = await fetch(base + '/health'); if (r.ok) return resolve({ base, journal: () => journal, stop: () => new Promise(f => { proc.once('exit', f); proc.kill(); }) }); } catch (e) {}
      if (Date.now() - debut > 20000) { proc.kill(); return reject(new Error('Le serveur ne demarre pas : ' + journal.slice(-500))); }
      setTimeout(attendre, 200);
    })();
  });
}
async function appel(S, methode, chemin, { token, body } = {}) {
  const r = await fetch(S.base + chemin, {
    method: methode,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text();
  let data; try { data = JSON.parse(txt); } catch { data = txt; }
  return { status: r.status, data };
}
const connexion = (S, email, mdp) => appel(S, 'POST', '/auth/login', { body: { email, password: mdp } });
const nettoyer = async () => {
  await sql("DELETE FROM invite_codes WHERE lower(source_email) IN ($1, $2)", [E1, E2]);
  await sql("DELETE FROM users WHERE email IN ($1, $2)", [E1, E2]);
  await sql("DELETE FROM paid_emails WHERE email IN ($1, $2)", [E1, E2]);
};
const ligne = async (email) => (await sql('SELECT * FROM paid_emails WHERE email = $1', [email]))[0];
const compte = async (email) => (await sql('SELECT * FROM users WHERE email = $1', [email]))[0];

(async () => {
  // Un schema vierge : on laisse un premier demarrage le creer.
  let S = await demarrer();
  await S.stop();
  await nettoyer();
  // Un vrai client, qui ne doit JAMAIS etre touche.
  await sql("INSERT INTO paid_emails (email, status, current_period_end, verified_at) VALUES ('client-reel@example.test', 'active', now() + interval '20 days', now()) ON CONFLICT (email) DO NOTHING");
  await sql("INSERT INTO users (id, email, password_hash, display_name, role) VALUES ('client-reel-id', 'client-reel@example.test', 'x', 'Client', 'caregiver') ON CONFLICT (email) DO NOTHING");

  // ===== 1. Sans les variables : aucun compte de test ===========================
  S = await demarrer();
  let r = await appel(S, 'GET', '/amazon/etat');
  check('sans variables : /amazon/etat renvoie pret (booleen) et relecteurs = 0', typeof r.data.pret === 'boolean' && r.data.relecteurs === 0, JSON.stringify(r.data));
  r = await connexion(S, E1, MDP1);
  check('sans variables : aucun compte relecteur (401)', r.status === 401, r.status);
  await S.stop();

  // ===== 2. Avec les deux variables : comptes crees au demarrage ================
  S = await demarrer({ REVIEWER_PASSWORD_1: MDP1, REVIEWER_PASSWORD_2: MDP2 });
  r = await appel(S, 'GET', '/amazon/etat');
  check('/amazon/etat : relecteurs = 2', r.status === 200 && r.data.relecteurs === 2, JSON.stringify(r.data));
  const r1 = await connexion(S, E1, MDP1);
  const r2 = await connexion(S, E2, MDP2);
  check('compte 1 : connexion (200, jeton, role caregiver)', r1.status === 200 && !!r1.data.token && r1.data.user.role === 'caregiver', JSON.stringify(r1.data));
  check('compte 2 : connexion (200, jeton, role caregiver)', r2.status === 200 && !!r2.data.token && r2.data.user.role === 'caregiver', JSON.stringify(r2.data));
  r = await connexion(S, E1, MDP2);
  check('compte 1 : le mot de passe du compte 2 est refuse (401)', r.status === 401, r.status);
  r = await connexion(S, E1, 'MauvaisMotDePasse1');
  check('compte 1 : un mauvais mot de passe est refuse (401)', r.status === 401, r.status);
  r = await appel(S, 'GET', '/billing/status', { token: r1.data.token });
  check('compte 1 : abonnement actif des la connexion', r.status === 200 && r.data.active === true, JSON.stringify(r.data));
  r = await appel(S, 'GET', '/billing/status', { token: r2.data.token });
  check('compte 2 : abonnement actif des la connexion', r.status === 200 && r.data.active === true, JSON.stringify(r.data));
  r = await appel(S, 'GET', '/auth/me', { token: r1.data.token });
  check('compte 1 : /auth/me repond', r.status === 200 && r.data.user.email === E1, JSON.stringify(r.data));
  // Les mots de passe ne doivent apparaitre dans aucun journal, ni en clair en base.
  const j = S.journal();
  check('journal : aucun mot de passe en clair', !j.includes(MDP1) && !j.includes(MDP2), j.slice(-300));
  check('journal : la creation des comptes est tracee', /\[relecteurs\] relecteur-amazon-1@example\.com : cree/.test(j) && /\[relecteurs\] relecteur-amazon-2@example\.com : cree/.test(j), j.slice(-300));
  const u1 = await compte(E1);
  check('base : le mot de passe est hache (bcrypt), jamais en clair', /^\$2[aby]\$/.test(u1.password_hash) && !u1.password_hash.includes(MDP1), u1.password_hash.slice(0, 10));
  const p1 = await ligne(E1);
  check('base : abonnement actif, longue echeance, verifie maintenant', p1.status === 'active' && new Date(p1.current_period_end).getTime() > Date.now() + 5 * 365 * 24 * 3600 * 1000 && Date.now() - new Date(p1.verified_at).getTime() < 60000, JSON.stringify(p1));
  await S.stop();

  // ===== 3. Redemarrage : rien ne change, les comptes ne sont pas recrees =========
  const idAvant = (await compte(E1)).id;
  S = await demarrer({ REVIEWER_PASSWORD_1: MDP1, REVIEWER_PASSWORD_2: MDP2 });
  const idApres = (await compte(E1)).id;
  r = await connexion(S, E1, MDP1);
  check('redemarrage : meme compte (meme identifiant), meme mot de passe', idAvant === idApres && r.status === 200, idAvant + ' / ' + idApres);
  check('redemarrage : rien a signaler dans le journal', !/\[relecteurs\]/.test(S.journal()), S.journal().slice(-300));
  await S.stop();

  // ===== 4. Mot de passe change dans Render : pris en compte au redemarrage =======
  S = await demarrer({ REVIEWER_PASSWORD_1: 'NouveauMotDePasse77', REVIEWER_PASSWORD_2: MDP2 });
  r = await connexion(S, E1, 'NouveauMotDePasse77');
  const ancien = await connexion(S, E1, MDP1);
  check('mot de passe change : le nouveau fonctionne, l\'ancien est refuse', r.status === 200 && ancien.status === 401, r.status + '/' + ancien.status);
  check('mot de passe change : le journal le mentionne sans le reveler', /relecteur-amazon-1@example\.com : mot de passe remis a jour/.test(S.journal()) && !S.journal().includes('NouveauMotDePasse77'), S.journal().slice(-300));
  await S.stop();

  // ===== 5. Un relecteur supprime le compte 2 : il est remis en etat ================
  S = await demarrer({ REVIEWER_PASSWORD_1: MDP1, REVIEWER_PASSWORD_2: MDP2 });
  r = await connexion(S, E2, MDP2);
  const jeton2 = r.data.token;
  r = await appel(S, 'DELETE', '/account', { token: jeton2, body: { password: MDP2 } });
  check('relecteur : "Supprimer mon compte" fonctionne sur le compte 2', r.status === 200 && r.data.deleted === true, JSON.stringify(r.data));
  r = await connexion(S, E2, MDP2);
  check('juste apres la suppression : la connexion est refusee (401)', r.status === 401, r.status);
  check('juste apres la suppression : compte et abonnement effaces en base', !(await compte(E2)) && !(await ligne(E2)), 'present');
  // La remise en etat periodique, appelee directement (sans attendre 30 minutes).
  process.env.REVIEWER_PASSWORD_1 = MDP1; process.env.REVIEWER_PASSWORD_2 = MDP2;
  const bilan = await require('./reviewers').assurerComptes();
  check('remise en etat : le compte 2 est recree, le compte 1 reste inchange', bilan.find(b => b.email === E2).etat === 'cree' && bilan.find(b => b.email === E1).etat === 'inchange', JSON.stringify(bilan));
  r = await connexion(S, E2, MDP2);
  check('remise en etat : le compte 2 est de nouveau utilisable', r.status === 200, r.status);
  r = await appel(S, 'GET', '/billing/status', { token: r.data.token });
  check('remise en etat : et il est abonne', r.data.active === true, JSON.stringify(r.data));
  await S.stop();

  // Le minuteur du serveur fait ce travail tout seul (ici toutes les 1,5 s au lieu de 30 min).
  S = await demarrer({ REVIEWER_PASSWORD_1: MDP1, REVIEWER_PASSWORD_2: MDP2, REVIEWER_REFRESH_MS: '1500' });
  await sql("DELETE FROM users WHERE email = $1", [E2]);
  await sql("DELETE FROM paid_emails WHERE email = $1", [E2]);
  let revenu = false;
  for (let i = 0; i < 24 && !revenu; i++) { await pause(500); revenu = (await connexion(S, E2, MDP2)).status === 200; }
  check('minuteur du serveur : un compte disparu revient tout seul', revenu, S.journal().slice(-300));
  r = await connexion(S, E1, MDP1);
  check('le compte 1 n\'a jamais ete touche', r.status === 200, r.status);
  await S.stop();
  delete process.env.REVIEWER_PASSWORD_1; delete process.env.REVIEWER_PASSWORD_2;

  // ===== 6. Mot de passe trop court : refuse, le serveur demarre quand meme ========
  await nettoyer();
  S = await demarrer({ REVIEWER_PASSWORD_1: 'abc', REVIEWER_PASSWORD_2: MDP2 });
  r = await appel(S, 'GET', '/amazon/etat');
  check('mot de passe trop court : le serveur demarre, un seul compte est cree', r.status === 200 && r.data.relecteurs === 1, JSON.stringify(r.data));
  check('mot de passe trop court : compte 1 absent, compte 2 present', !(await compte(E1)) && !!(await compte(E2)), '');
  check('mot de passe trop court : le journal l\'explique sans reveler la valeur', /REVIEWER_PASSWORD_1 est trop court/.test(S.journal()) && !S.journal().includes('abc'), S.journal().slice(-300));
  await S.stop();

  // ===== 7. Un echec sur un compte n'empeche ni le demarrage ni l'autre compte ======
  await nettoyer();
  await sql(`CREATE OR REPLACE FUNCTION test_refuse_relecteur_1() RETURNS trigger AS $$
    BEGIN IF NEW.email = '${E1}' THEN RAISE EXCEPTION 'panne simulee'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
  await sql('CREATE TRIGGER test_refuse_relecteur_1 BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION test_refuse_relecteur_1()');
  try {
    S = await demarrer({ REVIEWER_PASSWORD_1: MDP1, REVIEWER_PASSWORD_2: MDP2 });
    r = await connexion(S, E2, MDP2);
    check('panne sur le compte 1 : le serveur demarre et le compte 2 est cree', r.status === 200, r.status);
    check('panne sur le compte 1 : l\'echec est journalise', /relecteur-amazon-1@example\.com : echec/.test(S.journal()), S.journal().slice(-300));
    check('panne sur le compte 1 : aucun compte a moitie cree (pas d\'abonnement orphelin)', !(await ligne(E1)), JSON.stringify(await ligne(E1)));
    await S.stop();
  } finally {
    await sql('DROP TRIGGER IF EXISTS test_refuse_relecteur_1 ON users');
    await sql('DROP FUNCTION IF EXISTS test_refuse_relecteur_1()');
  }

  // ===== 8. Variables retirees apres l'approbation : les comptes disparaissent ======
  S = await demarrer({ REVIEWER_PASSWORD_1: MDP1, REVIEWER_PASSWORD_2: MDP2 });
  const idRel = (await compte(E1)).id;
  await sql("INSERT INTO invite_codes (code, inviter_id, inviter_role, expires_at) VALUES ('CODE-RELECTEUR-TEST', $1, 'caregiver', now() + interval '7 days')", [idRel]);
  await S.stop();
  S = await demarrer();   // plus aucune variable
  r = await appel(S, 'GET', '/amazon/etat');
  check('variables retirees : /amazon/etat annonce relecteurs = 0', r.data.relecteurs === 0, JSON.stringify(r.data));
  r = await connexion(S, E1, MDP1);
  const r2b = await connexion(S, E2, MDP2);
  check('variables retirees : les deux comptes ne peuvent plus se connecter', r.status === 401 && r2b.status === 401, r.status + '/' + r2b.status);
  check('variables retirees : comptes, abonnements et codes d\'invitation effaces', !(await compte(E1)) && !(await compte(E2)) && !(await ligne(E1)) && !(await ligne(E2)) && (await sql("SELECT 1 FROM invite_codes WHERE code = 'CODE-RELECTEUR-TEST'")).length === 0, 'reste');
  check('variables retirees : la suppression est tracee', /relecteur-amazon-1@example\.com : supprime/.test(S.journal()), S.journal().slice(-300));
  await S.stop();

  // ===== 9. Un vrai client n'est jamais touche ======================================
  const client = await compte('client-reel@example.test');
  const clientPaye = await ligne('client-reel@example.test');
  check('un vrai client (hors relecteurs) reste intact apres tous ces cycles', !!client && !!clientPaye && clientPaye.status === 'active', JSON.stringify({ client: !!client, clientPaye }));

  await sql("DELETE FROM users WHERE email = 'client-reel@example.test'");
  await sql("DELETE FROM paid_emails WHERE email = 'client-reel@example.test'");
  await nettoyer();
  console.log(results.join('\n'));
  console.log(`\n${pass} tests reussis, ${fail} echec(s).`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error('ERREUR DU TEST :', e);
  for (const p of lances) { try { p.kill(); } catch (_) {} }
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});
