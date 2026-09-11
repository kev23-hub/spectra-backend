#!/usr/bin/env node
// Deplace la base Spectra d'un hebergeur a un autre, sans installer pg_dump.
//
// A QUOI CA SERT : les bases gratuites de Render expirent au bout de 30 jours
// et sont ensuite supprimees. Ce script copie tout vers une base durable
// (Neon, Supabase, Aiven... toutes gratuites et sans limite de duree) en
// quelques minutes, sans rien installer d'autre que ce depot.
//
// Usage :
//   node migrer-base.js "<URL de l'ancienne base>" "<URL de la nouvelle base>"
//
// Les deux URL se trouvent dans le tableau de bord de chaque hebergeur.
// Le script ne supprime jamais rien : l'ancienne base reste intacte.

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const SOURCE = process.argv[2];
const CIBLE = process.argv[3];
if (!SOURCE || !CIBLE) {
  console.error('Usage : node migrer-base.js "<ancienne URL>" "<nouvelle URL>"');
  process.exit(2);
}

const TABLES = ['users', 'links', 'invite_codes', 'kv_store', 'push_subscriptions', 'subscriptions', 'paid_emails'];

function pool(url) {
  return new Pool({
    connectionString: url,
    ssl: url.includes('localhost') ? false : { rejectUnauthorized: false },
    max: 3,
  });
}

(async () => {
  const src = pool(SOURCE);
  const dst = pool(CIBLE);
  try {
    console.log('Lecture de l\'ancienne base...');
    const donnees = {};
    for (const t of TABLES) {
      donnees[t] = (await src.query(`SELECT * FROM ${t}`)).rows;
      console.log(`  ${t.padEnd(20)} ${donnees[t].length} ligne(s)`);
    }

    console.log('\nCreation du schema dans la nouvelle base...');
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await dst.query(schema);

    console.log('Copie des donnees...');
    let total = 0;
    for (const t of TABLES) {
      let n = 0;
      for (const ligne of donnees[t]) {
        const cols = Object.keys(ligne);
        const trous = cols.map((_, i) => '$' + (i + 1)).join(', ');
        try {
          await dst.query(
            `INSERT INTO ${t} (${cols.join(', ')}) VALUES (${trous}) ON CONFLICT DO NOTHING`,
            cols.map(c => ligne[c])
          );
          n++;
        } catch (e) {
          console.error(`  ${t}: une ligne n'a pas pu etre copiee (${e.message})`);
        }
      }
      total += n;
      console.log(`  ${t.padEnd(20)} ${n} copiee(s)`);
    }

    console.log('\nVerification...');
    let ecart = 0;
    for (const t of TABLES) {
      const avant = donnees[t].length;
      const apres = (await dst.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
      const bon = apres >= avant;
      if (!bon) ecart++;
      console.log(`  ${bon ? 'OK  ' : 'ECART'} ${t.padEnd(20)} ${avant} -> ${apres}`);
    }

    console.log(`\n${total} ligne(s) copiee(s), ${ecart} ecart(s).`);
    if (ecart === 0) {
      console.log('\nMigration reussie. Remplacez maintenant DATABASE_URL sur Render par');
      console.log('la nouvelle URL, puis redemarrez le service. Gardez l\'ancienne base');
      console.log('quelques jours avant de la laisser expirer.');
    }
    process.exit(ecart ? 1 : 0);
  } catch (e) {
    console.error('\nEchec :', e.message);
    process.exit(1);
  } finally {
    await src.end().catch(() => {});
    await dst.end().catch(() => {});
  }
})();
