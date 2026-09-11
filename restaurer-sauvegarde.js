#!/usr/bin/env node
// Reinjecte une sauvegarde Spectra dans une base vide.
//
// Usage :
//   node restaurer-sauvegarde.js sauvegarde.json "<URL de la base>"
//   node restaurer-sauvegarde.js sauvegarde.json.enc "<URL>" "<phrase secrete>"
//
// Les fichiers .enc sont ceux deposes automatiquement sur GitHub : ils sont
// chiffres, il faut donc fournir BACKUP_PASSPHRASE en troisieme argument.

const fs = require('fs');
const fichier = process.argv[2];
const url = process.argv[3];
const phrase = process.argv[4] || process.env.BACKUP_PASSPHRASE;

if (!fichier || !url) {
  console.error('Usage : node restaurer-sauvegarde.js <fichier> "<URL de la base>" [phrase secrete]');
  process.exit(2);
}
process.env.DATABASE_URL = url;

const backup = require('./backup');

(async () => {
  let brut = fs.readFileSync(fichier, 'utf8');
  let dump;
  try {
    const objet = JSON.parse(brut);
    dump = objet.chiffrement ? JSON.parse(backup.dechiffrer(objet, phrase)) : objet;
  } catch (e) {
    console.error('Fichier illisible :', e.message);
    console.error(phrase ? '' : 'Sauvegarde chiffree ? Fournissez la phrase secrete en 3e argument.');
    process.exit(1);
  }
  console.log(`Sauvegarde du ${dump.date}, ${dump.lignes} ligne(s).`);
  const bilan = await backup.restore(dump);
  console.log('\nRestaure :');
  for (const [t, n] of Object.entries(bilan)) console.log(`  ${t.padEnd(20)} ${n}`);
  console.log('\nTermine.');
  process.exit(0);
})().catch(e => { console.error('Echec :', e.message); process.exit(1); });
