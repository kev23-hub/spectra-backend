// Connexion PostgreSQL.
//
// POURQUOI CE CHANGEMENT : la version précédente utilisait SQLite dans un
// fichier local. Sur une instance Render gratuite, le disque est EPHEMERE :
// il est effacé à chaque redémarrage ou sortie de veille. Tous les comptes,
// abonnements et codes d'invitation des clients disparaissaient donc
// régulièrement. PostgreSQL est une vraie base persistante, hors du conteneur.
//
// Définissez DATABASE_URL dans les variables d'environnement Render
// (Render vous la fournit automatiquement si vous créez une base Postgres
// dans le même projet et l'attachez au service).

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL manquante. Créez une base PostgreSQL (Render > New > Postgres), ' +
    'puis ajoutez sa "Internal Database URL" dans les variables d\'environnement du service.'
  );
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
  max: 5,
});

// Traduit les "?" (style SQLite) en "$1, $2..." (style PostgreSQL), afin de
// garder les requêtes du reste du code lisibles et proches de l'original.
function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => '$' + (++i));
}

async function query(sql, params = []) {
  const res = await pool.query(toPg(sql), params);
  return res.rows;
}

// Renvoie la première ligne, ou undefined.
async function get(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0];
}

// Exécute sans se soucier du résultat.
async function run(sql, params = []) {
  await pool.query(toPg(sql), params);
}

// Exécute plusieurs requêtes dans une transaction.
async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const helpers = {
      query: async (sql, params = []) => (await client.query(toPg(sql), params)).rows,
      get: async (sql, params = []) => (await client.query(toPg(sql), params)).rows[0],
      run: async (sql, params = []) => { await client.query(toPg(sql), params); },
    };
    const result = await fn(helpers);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Crée les tables au démarrage si elles n'existent pas encore.
async function init() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);
  console.log('[db] Schéma PostgreSQL vérifié.');
}

module.exports = { query, get, run, transaction, init, pool };
