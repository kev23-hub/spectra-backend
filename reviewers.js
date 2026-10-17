// reviewers.js
//
// Comptes de TEST pour les relecteurs de l'Appstore Amazon.
//
// Amazon doit pouvoir se connecter a l'application sans rien acheter. Ces deux
// comptes sont crees (ou remis en etat) par le serveur LUI-MEME au demarrage,
// puis toutes les 30 minutes : il n'y a rien a saisir dans Neon.
//
//   REVIEWER_PASSWORD_1   mot de passe de relecteur-amazon-1@example.com
//   REVIEWER_PASSWORD_2   mot de passe de relecteur-amazon-2@example.com
//
// Variables d'environnement Render (8 caracteres minimum). Le mot de passe
// n'est JAMAIS ecrit dans le code ni dans les journaux.
//
//   - variable renseignee  : le compte existe, est abonne (sans limite de
//                            duree) et a exactement ce mot de passe ;
//   - variable absente ou vide : le compte est SUPPRIME. Apres l'approbation
//                            d'Amazon, il suffit donc de retirer les deux
//                            variables dans Render : les comptes disparaissent
//                            au redemarrage qui suit.
//
// Les adresses sont en example.com (domaine reserve, qui ne peut pas appartenir
// a un vrai client) : seules ces deux adresses sont creees ou supprimees ici.
//
// La remise en etat toutes les 30 minutes sert quand un relecteur a utilise
// "Supprimer mon compte" (le compte 2 est prevu pour cela) : le compte revient
// pour le relecteur suivant.

const bcrypt = require('bcryptjs');
const { randomUUID } = require('crypto');
const db = require('./db');

const COMPTES = [
  { email: 'relecteur-amazon-1@example.com', variable: 'REVIEWER_PASSWORD_1', nom: 'Relecteur Amazon 1' },
  { email: 'relecteur-amazon-2@example.com', variable: 'REVIEWER_PASSWORD_2', nom: 'Relecteur Amazon 2' },
];
const LONGUEUR_MIN = 8;
// Reglage de TEST uniquement (REVIEWER_REFRESH_MS) : par defaut, toutes les 30 minutes.
const PERIODE_MS = Number(process.env.REVIEWER_REFRESH_MS) > 0 ? Number(process.env.REVIEWER_REFRESH_MS) : 30 * 60 * 1000;

function motDePasse(compte) {
  return String(process.env[compte.variable] || '').trim();
}

async function supprimer(compte) {
  const utilisateur = await db.get('SELECT id FROM users WHERE email = ?', [compte.email]);
  const paye = await db.get('SELECT email FROM paid_emails WHERE email = ?', [compte.email]);
  if (!utilisateur && !paye) return 'absent';
  await db.transaction(async (t) => {
    if (utilisateur) {
      await t.run('DELETE FROM invite_codes WHERE inviter_id = ? OR lower(source_email) = lower(?)', [utilisateur.id, compte.email]);
    }
    await t.run('DELETE FROM paid_emails WHERE email = ?', [compte.email]);
    await t.run('DELETE FROM users WHERE email = ?', [compte.email]);
  });
  return 'supprime';
}

async function creerOuRemettreEnEtat(compte, mdp) {
  return db.transaction(async (t) => {
    // Abonnement "actif" sans limite pratique. verified_at toujours recent : le
    // serveur n'interroge donc jamais Stripe pour ces adresses.
    await t.run(`
      INSERT INTO paid_emails (email, status, current_period_end, verified_at)
      VALUES (?, 'active', now() + interval '10 years', now())
      ON CONFLICT (email) DO UPDATE SET
        status = 'active',
        current_period_end = now() + interval '10 years',
        verified_at = now(),
        updated_at = now()
    `, [compte.email]);

    const utilisateur = await t.get('SELECT id, password_hash FROM users WHERE email = ?', [compte.email]);
    if (!utilisateur) {
      await t.run(
        'INSERT INTO users (id, email, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)',
        [randomUUID(), compte.email, await bcrypt.hash(mdp, 10), compte.nom, 'caregiver']
      );
      return 'cree';
    }
    if (!(await bcrypt.compare(mdp, utilisateur.password_hash))) {
      await t.run('UPDATE users SET password_hash = ? WHERE id = ?', [await bcrypt.hash(mdp, 10), utilisateur.id]);
      return 'mot de passe remis a jour';
    }
    return 'inchange';
  });
}

async function assurerCompte(compte) {
  const mdp = motDePasse(compte);
  if (!mdp) return supprimer(compte);
  if (mdp.length < LONGUEUR_MIN) {
    console.error(`[relecteurs] ${compte.variable} est trop court (${LONGUEUR_MIN} caracteres minimum) : ${compte.email} n'est pas cree.`);
    return 'refuse';
  }
  return creerOuRemettreEnEtat(compte, mdp);
}

// Un echec sur un compte ne doit jamais empecher le serveur de fonctionner.
async function assurerComptes() {
  const bilan = [];
  for (const compte of COMPTES) {
    try {
      const etat = await assurerCompte(compte);
      bilan.push({ email: compte.email, etat });
      if (etat !== 'inchange' && etat !== 'absent' && etat !== 'refuse') {
        console.log(`[relecteurs] ${compte.email} : ${etat}`);
      }
    } catch (e) {
      bilan.push({ email: compte.email, etat: 'erreur' });
      console.error(`[relecteurs] ${compte.email} : echec (${e.message})`);
    }
  }
  return bilan;
}

// Nombre de comptes de test prets a servir (existent ET abonnes). Affiche par
// GET /amazon/etat pour que vous puissiez le verifier sans ouvrir Neon.
async function compter() {
  const ligne = await db.get(
    `SELECT count(*)::int AS n
       FROM users u JOIN paid_emails p ON p.email = u.email
      WHERE u.email = ANY(?) AND p.status = 'active'`,
    [COMPTES.map((c) => c.email)]
  );
  return ligne ? ligne.n : 0;
}

// A appeler une fois le serveur demarre (le premier passage se fait avant, voir
// server.js : les comptes existent des la premiere requete).
function planifier() {
  const minuteur = setInterval(() => {
    assurerComptes().catch((e) => console.error('[relecteurs]', e.message));
  }, PERIODE_MS);
  if (minuteur.unref) minuteur.unref();
}

module.exports = { COMPTES, assurerComptes, compter, planifier, PERIODE_MS };
