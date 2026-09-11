// Verifie que l'application fonctionne meme si le webhook Stripe n'existe pas.
// Stripe est simule : aucun appel reseau, aucun compte reel necessaire.
const Module = require('module');

let appelsStripe = 0;
let etatSimule = 'active';     // statut renvoye par le faux Stripe
let clientExiste = true;

const fauxStripe = {
  customers: {
    list: async ({ email }) => {
      appelsStripe++;
      return { data: clientExiste ? [{ id: 'cus_simule', email }] : [] };
    },
  },
  subscriptions: {
    list: async () => ({
      data: etatSimule
        ? [{ id: 'sub_simule', status: etatSimule, current_period_end: Math.floor(Date.now()/1000) + 86400,
             items: { data: [{ price: { id: 'price_x' } }] } }]
        : [],
    }),
  },
};

const chargerOrigine = Module._load;
Module._load = function (demande, parent, isMain) {
  if (demande === 'stripe') return function () { return fauxStripe; };
  return chargerOrigine.apply(this, arguments);
};

process.env.STRIPE_SECRET_KEY = 'sk_test_simule';
const db = require('./db');
const { isEmailPaid } = require('./routes/billing');

let ok = 0, ko = 0;
const t = (nom, cond, detail) => { cond ? ok++ : ko++; console.log(`${cond ? 'OK  ' : 'ECHEC'}  ${nom}${cond ? '' : '  -> ' + detail}`); };

(async () => {
  await db.init();
  const mail = 'paye-sans-webhook@test.fr';
  await db.run('DELETE FROM paid_emails WHERE email = ?', [mail]);

  // 1. Aucun webhook n'est jamais arrive : la table est vide.
  const avant = await db.get('SELECT 1 FROM paid_emails WHERE email = ?', [mail]);
  t('depart : aucune trace du paiement en base (webhook absent)', !avant);

  // 2. Le client tente de creer son compte : le serveur interroge Stripe.
  const autorise = await isEmailPaid(mail);
  t('le client est reconnu malgre l\'absence de webhook', autorise === true, autorise);
  const apres = await db.get('SELECT status, stripe_customer_id, verified_at FROM paid_emails WHERE email = ?', [mail]);
  t('le paiement est enregistre en base pour la suite', apres && apres.status === 'active' && apres.stripe_customer_id === 'cus_simule', JSON.stringify(apres));
  t('la date de controle est memorisee', !!(apres && apres.verified_at), JSON.stringify(apres));

  // 3. Deuxieme appel immediat : on ne redemande pas a Stripe (economie d'appels).
  const avantAppels = appelsStripe;
  await isEmailPaid(mail);
  t('pas de nouvel appel a Stripe dans les 12 h', appelsStripe === avantAppels, `${avantAppels} -> ${appelsStripe}`);

  // 4. Le client resilie, toujours sans webhook. On force l'expiration du controle.
  etatSimule = 'canceled';
  await db.run("UPDATE paid_emails SET verified_at = now() - interval '13 hours' WHERE email = ?", [mail]);
  const encoreAutorise = await isEmailPaid(mail);
  t('la resiliation est detectee sans webhook', encoreAutorise === false, encoreAutorise);
  const final = await db.get('SELECT status FROM paid_emails WHERE email = ?', [mail]);
  t('la base est mise a jour en "canceled"', final && final.status === 'canceled', JSON.stringify(final));

  // 5. Une adresse qui n'a jamais rien paye reste refusee.
  clientExiste = false;
  const inconnu = await isEmailPaid('jamais-paye@test.fr');
  t('une adresse sans paiement reste refusee', inconnu === false, inconnu);
  const fantome = await db.get('SELECT 1 FROM paid_emails WHERE email = ?', ['jamais-paye@test.fr']);
  t('aucune ligne fantome creee', !fantome);

  await db.run('DELETE FROM paid_emails WHERE email = ?', [mail]);
  console.log(`\n${ok} tests reussis, ${ko} echec(s).`);
  process.exit(ko ? 1 : 0);
})();
