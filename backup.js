// Sauvegarde et restauration de la base Spectra.
//
// POURQUOI CE FICHIER : les bases PostgreSQL gratuites de Render expirent
// 30 jours apres leur creation et sont ensuite supprimees, sans aucune
// sauvegarde fournie. Sans ce module, les comptes de vos clients payants
// disparaissent au bout d'un mois, definitivement.
//
// Ce module fonctionne avec n'importe quel hebergeur de base, gratuit ou non,
// et ne coute rien : la sauvegarde est un fichier JSON chiffre, que vous
// pouvez telecharger a la demande ou laisser deposer automatiquement chaque
// jour dans un depot GitHub PRIVE (gratuit, et illimite en depots prives).

const crypto = require('crypto');
const db = require('./db');

// Ordre important : les tables filles apres les tables parentes, sinon la
// restauration viole les cles etrangeres.
const TABLES = [
  'users',
  'links',
  'invite_codes',
  'kv_store',
  'push_subscriptions',
  'subscriptions',
  'paid_emails',
];

async function dumpAll() {
  const tables = {};
  for (const t of TABLES) {
    tables[t] = await db.query(`SELECT * FROM ${t}`);
  }
  const total = Object.values(tables).reduce((n, r) => n + r.length, 0);
  return { format: 'spectra-backup-1', date: new Date().toISOString(), lignes: total, tables };
}

// --- Chiffrement -----------------------------------------------------------
// AES-256-GCM, cle derivee de BACKUP_PASSPHRASE. Une sauvegarde contient les
// adresses e-mail de vos clients : elle ne doit jamais circuler en clair, meme
// dans un depot prive.
function chiffrer(texte, passphrase) {
  const sel = crypto.randomBytes(16);
  const cle = crypto.scryptSync(passphrase, sel, 32);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', cle, iv);
  const donnees = Buffer.concat([c.update(texte, 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return JSON.stringify({
    chiffrement: 'aes-256-gcm',
    sel: sel.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    donnees: donnees.toString('base64'),
  });
}

function dechiffrer(paquet, passphrase) {
  const p = typeof paquet === 'string' ? JSON.parse(paquet) : paquet;
  const cle = crypto.scryptSync(passphrase, Buffer.from(p.sel, 'base64'), 32);
  const d = crypto.createDecipheriv('aes-256-gcm', cle, Buffer.from(p.iv, 'base64'));
  d.setAuthTag(Buffer.from(p.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(p.donnees, 'base64')), d.final()]).toString('utf8');
}

// --- Restauration ----------------------------------------------------------
// Reinjecte une sauvegarde dans une base vide (ou partiellement remplie).
// Les lignes deja presentes sont ignorees, jamais ecrasees.
async function restore(dump) {
  if (!dump || dump.format !== 'spectra-backup-1') {
    throw new Error('Fichier de sauvegarde non reconnu.');
  }
  await db.init();
  const bilan = {};
  for (const t of TABLES) {
    const lignes = dump.tables[t] || [];
    let n = 0;
    for (const ligne of lignes) {
      const colonnes = Object.keys(ligne);
      const trous = colonnes.map(() => '?').join(', ');
      try {
        await db.run(
          `INSERT INTO ${t} (${colonnes.join(', ')}) VALUES (${trous}) ON CONFLICT DO NOTHING`,
          colonnes.map(c => ligne[c])
        );
        n++;
      } catch (e) {
        console.error(`[backup] ${t}: ligne ignoree (${e.message})`);
      }
    }
    bilan[t] = n;
  }
  return bilan;
}

// --- Depot automatique sur GitHub -----------------------------------------
// Necessite GITHUB_TOKEN (jeton "contents: write" sur un depot PRIVE),
// GITHUB_BACKUP_REPO au format "utilisateur/depot", et BACKUP_PASSPHRASE.
// Si l'une des trois manque, rien ne part : c'est volontaire.
async function pousserSurGithub() {
  const token = process.env.GITHUB_TOKEN;
  const depot = process.env.GITHUB_BACKUP_REPO;
  const phrase = process.env.BACKUP_PASSPHRASE;
  if (!token || !depot || !phrase) return { envoye: false, raison: 'configuration incomplete' };

  const dump = await dumpAll();
  const contenu = Buffer.from(chiffrer(JSON.stringify(dump), phrase), 'utf8').toString('base64');
  const jour = new Date().toISOString().slice(0, 10);
  const chemin = `sauvegardes/spectra-${jour}.json.enc`;
  const url = `https://api.github.com/repos/${depot}/contents/${chemin}`;
  const entetes = {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'spectra-backup',
    'Content-Type': 'application/json',
  };

  // Si le fichier du jour existe deja, GitHub exige son sha pour l'ecraser.
  let sha;
  try {
    const r = await fetch(url, { headers: entetes });
    if (r.ok) sha = (await r.json()).sha;
  } catch (e) {}

  const r = await fetch(url, {
    method: 'PUT',
    headers: entetes,
    body: JSON.stringify({
      message: `Sauvegarde Spectra du ${jour} (${dump.lignes} lignes)`,
      content: contenu,
      ...(sha ? { sha } : {}),
    }),
  });
  if (!r.ok) {
    const txt = await r.text();
    console.error('[backup] GitHub a refuse la sauvegarde :', r.status, txt.slice(0, 200));
    return { envoye: false, raison: `GitHub ${r.status}` };
  }
  console.log(`[backup] Sauvegarde deposee : ${chemin} (${dump.lignes} lignes)`);
  return { envoye: true, chemin, lignes: dump.lignes };
}

// Planification : une sauvegarde peu apres le demarrage, puis toutes les 24 h.
// Render n'offre pas de taches planifiees sur le plan gratuit ; on se contente
// donc du processus web, qui tourne des qu'un utilisateur se connecte.
function planifierSauvegardes() {
  if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_BACKUP_REPO || !process.env.BACKUP_PASSPHRASE) {
    console.log('[backup] Sauvegarde automatique desactivee (GITHUB_TOKEN, GITHUB_BACKUP_REPO ou BACKUP_PASSPHRASE manquant).');
    return;
  }
  const lancer = () => pousserSurGithub().catch(e => console.error('[backup]', e.message));
  setTimeout(lancer, 2 * 60 * 1000);
  setInterval(lancer, 24 * 3600 * 1000);
  console.log('[backup] Sauvegarde automatique activee (toutes les 24 h).');
}

module.exports = { dumpAll, restore, chiffrer, dechiffrer, pousserSurGithub, planifierSauvegardes, TABLES };
