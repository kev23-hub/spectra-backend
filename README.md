# Backend de démarrage — Spectra

Ce dossier est un vrai backend fonctionnel (Node.js + Express + SQLite), pas une maquette.
Il couvre exactement les trois manques identifiés : comptes, liaison aidant ↔ personne,
et notifications push réelles. Il n'est **pas déployé** — vous (ou un développeur) devez
l'héberger vous-même. Voici comment, et ce que ça implique.

## 1. Faire tourner le backend en local (pour tester)

```bash
cd backend-starter
npm install
cp .env.example .env
# éditez .env : mettez un JWT_SECRET long et aléatoire
npx web-push generate-vapid-keys   # collez les deux clés dans .env
npm start
```

Le serveur écoute sur `http://localhost:3000`. Testez avec :
```bash
curl http://localhost:3000/health
```

## 2. Ce que le backend fait déjà

- **Comptes** (`/auth/register`, `/auth/login`) — email + mot de passe, hachage bcrypt, jeton JWT valable 30 jours.
- **Liaison aidant ↔ personne, dans les deux sens** (`/link/invite`, `/link/redeem`, `/link/mine`) — n'importe quel compte (personne OU aidant) peut générer un code d'invitation (ex. `SPEC-7F3K`, valable 7 jours) ; seul un compte du rôle opposé peut l'utiliser, une seule fois. Concrètement : peu importe qui télécharge l'app en premier, la personne autiste ou l'aidant, chacun peut inviter l'autre. Un aidant peut être lié à plusieurs personnes ; une personne peut avoir plusieurs aidants.
- **Envoi d'invitation par e-mail réel** (`email.js`, via [Resend](https://resend.com)) — si une adresse e-mail est fournie lors de la création de l'invitation, un vrai e-mail est envoyé avec un lien direct et le code. Sans `RESEND_API_KEY` configurée, le lien est simplement affiché dans les journaux du serveur (pratique pour tester avant d'avoir un compte Resend).
- **Synchronisation** (`/sync/:key`) — reproduit exactement la sémantique `personal`/`shared` déjà utilisée dans `index.html` (fonctions `storageGet`/`storageSet`). Un aidant lié ne peut **jamais** lire les données privées d'une personne, seulement celles explicitement partagées — j'ai gardé la même règle d'autonomie que dans l'application elle-même.
- **Notifications push réelles** (`/push/subscribe`, `/push/test`, fonction `notifyLinkedCaregivers`) via le protocole Web Push standard (fonctionne sur Chrome, Firefox, Edge, Safari 16.4+).
- **Achats intégrés Amazon** (application Fire) — vérification serveur des reçus auprès d'Amazon, en complément de Stripe (voir la section 6).

## 3. Ce qu'il reste à faire pour une vraie mise en production

1. **Héberger le serveur** : Render, Railway ou Fly.io ont un plan gratuit ou très bas coût et déploient un dépôt Node.js en quelques clics (poussez `backend-starter/` sur GitHub, connectez le repo). Une alternative : un petit VPS (5 €/mois) avec `pm2` pour garder le process actif.
2. **Remplacer SQLite par une base plus robuste** en production réelle (PostgreSQL) si vous prévoyez plus de quelques centaines d'utilisateurs simultanés — SQLite suffit largement pour commencer et tester.
3. **HTTPS obligatoire** : les notifications push et les service workers ne fonctionnent qu'en HTTPS. Render/Railway/Fly.io le fournissent automatiquement.
4. **Brancher `index.html` sur cette API** au lieu de (ou en plus de) `window.storage`/`localStorage`. Voici le principe, à adapter dans les fonctions `storageGet`/`storageSet` du fichier :

```js
const API_BASE = 'https://votre-backend.example.com';
let authToken = localStorage.getItem('spectra_token'); // recupere apres /auth/login

async function apiStorageGet(key, shared, personId){
  const url = new URL(API_BASE + '/sync/' + key);
  if(shared) url.searchParams.set('shared', '1');
  if(personId) url.searchParams.set('personId', personId);
  const r = await fetch(url, { headers:{ Authorization:'Bearer '+authToken } });
  const data = await r.json();
  return data.value;
}
async function apiStorageSet(key, value, shared, personId){
  await fetch(API_BASE + '/sync/' + key, {
    method:'POST',
    headers:{ 'Content-Type':'application/json', Authorization:'Bearer '+authToken },
    body: JSON.stringify({ value, shared, personId }),
  });
}
```

   Ensuite, faites de `storageGet`/`storageSet` un simple aiguillage : si `authToken` existe, appelez l'API ; sinon, gardez le repli `localStorage` déjà en place. Ça permet de garder l'app 100 % fonctionnelle hors-ligne/sans compte, et de gagner la synchronisation réelle dès qu'un compte est créé.

5. **Écran de connexion/inscription** dans `index.html` — actuellement absent, à ajouter (formulaire simple appelant `/auth/register` et `/auth/login`, stockage du jeton reçu).
6. **Déclencher les push réellement** : par exemple, quand le signal de détresse (`distressAlert`) est enregistré côté `/sync`, appeler `notifyLinkedCaregivers(personId, {...})` exporté par `routes/push.js`.
7. **RGPD/HDS** : une fois de vraies données de santé stockées sur un vrai serveur, il vous faudra un hébergeur certifié HDS (en France) et une politique de confidentialité réelle — voir `PRIVACY-POLICY-DRAFT.md` à la racine, qui est un point de départ, pas un document juridique validé.

## 4. Sécurité, ce qui est fait et ce qui ne l'est pas

Fait : mots de passe hachés (bcrypt), jetons signés (JWT), séparation stricte privé/partagé, validation des liens avant tout accès croisé.
Pas fait, à ajouter avant une vraie mise en production : limitation du débit des requêtes (rate limiting), vérification d'email, réinitialisation de mot de passe, journal d'audit des accès, tests automatisés.

## 5. Paiements Stripe — marche à suivre complète

Le fichier `routes/billing.js` contient une vraie intégration Stripe (abonnement récurrent), pas une maquette. Voici comment l'activer, dans l'ordre.

### 5.1 Créer le produit et récupérer les clés (en mode Test d'abord)

1. Créez un compte sur [dashboard.stripe.com](https://dashboard.stripe.com) si vous n'en avez pas.
2. Restez en **mode Test** (bascule en haut à droite du tableau de bord) tant que vous n'êtes pas prêt à encaisser de vrais paiements.
3. Allez dans **Développeurs > Clés API** : copiez la **clé secrète** (`sk_test_...`) — collez-la uniquement dans votre fichier `.env` local, jamais ailleurs.
4. Allez dans **Produits > Ajouter un produit**, créez votre offre (ex. « Spectra Famille », tarif mensuel), puis copiez l'identifiant du prix (`price_...`) dans `STRIPE_DEFAULT_PRICE_ID`.

### 5.2 Configurer le webhook (l'étape la plus souvent oubliée)

Sans webhook, Stripe encaisse le paiement mais votre base de données ne le saura jamais — l'abonnement ne s'activera pas.

- **En local**, utilisez le [Stripe CLI](https://stripe.com/docs/stripe-cli) :
  ```bash
  stripe listen --forward-to localhost:3000/billing/webhook
  ```
  Cette commande affiche un secret `whsec_...` à copier dans `STRIPE_WEBHOOK_SECRET`.
- **En production**, dans le Dashboard Stripe : **Développeurs > Webhooks > Ajouter un endpoint**, avec l'URL `https://votre-domaine.example/billing/webhook`, et cochez au minimum les événements `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`. Stripe vous donne alors le vrai `whsec_...` de production à mettre dans le `.env` du serveur déployé.

### 5.3 Déclencher un paiement depuis `index.html`

Le principe : votre frontend appelle votre backend (avec le jeton d'authentification), qui crée une session Stripe et renvoie une URL de redirection.

```js
async function startCheckout(){
  const r = await fetch(API_BASE + '/billing/create-checkout-session', {
    method: 'POST',
    headers: { 'Content-Type':'application/json', Authorization: 'Bearer ' + authToken },
    body: JSON.stringify({}), // priceId optionnel si STRIPE_DEFAULT_PRICE_ID est defini
  });
  const { url } = await r.json();
  window.location.href = url; // redirection vers la page de paiement Stripe
}
```

Une fois le paiement effectué, Stripe redirige l'utilisateur vers `APP_URL/billing/success`, et le webhook aura déjà mis à jour `subscriptions.status = 'active'` en base — vérifiable via `GET /billing/status`.

### 5.4 Gérer l'abonnement (annulation, moyen de paiement)

Appelez `POST /billing/create-portal-session` : Stripe fournit une page toute faite où l'utilisateur peut annuler, changer de carte ou voir ses factures — vous n'avez pas à construire cet écran vous-même.

### 5.5 Passer en production

Remplacez `sk_test_...` par `sk_live_...`, recréez le produit/prix en mode Live (les objets Test et Live sont séparés dans Stripe), et reconfigurez un webhook de production avec sa propre signature. Testez d'abord une transaction réelle à faible montant avant toute annonce publique.

## 6. Amazon Appstore — achats intégrés (application Fire)

**Pourquoi.** L'Appstore d'Amazon impose de vendre l'abonnement avec son propre système d'achat intégré (*In-App Purchasing*) dans l'application Fire : on ne peut pas y renvoyer vers Stripe. Stripe reste utilisé pour le **site web**, et rien n'a changé pour ce circuit. Un même e-mail peut avoir un abonnement Stripe, un abonnement Amazon, ou les deux : **l'accès est ouvert si l'un des deux est actif**. Les deux circuits écrivent dans des colonnes séparées de `paid_emails` (`amazon_*` pour Amazon), donc aucun ne peut écraser l'autre.

**Principe.** Le serveur ne croit jamais l'application (« j'ai payé ») : il demande à Amazon, avec une clé secrète qu'il est le seul à connaître, si le reçu est réel et si l'abonnement court encore (*Receipt Verification Service*, code dans `amazon.js`).

**Produits Amazon.** Abonnement parent `spectra_abonnement`, durée mensuelle `spectra_abonnement_mensuel` (ce sont les identifiants déjà présents dans `app.html`). L'achat se lance avec l'identifiant de la **durée** ; le reçu porte celui du **parent**.

### 6.1 Variables d'environnement (Render > Environment)

| Variable | Rôle |
|---|---|
| `AMAZON_RVS_SECRET` | **Obligatoire.** Clé partagée, sur https://developer.amazon.com/sdk/shared-key.html. Ne jamais la coller dans une conversation ni dans Git. |
| `AMAZON_RVS_MODE` | `production` (défaut). `auto` **uniquement pendant vos essais** avec l'outil *App Tester* d'Amazon, puis à retirer. Les accès obtenus en mode d'essai s'éteignent d'eux-mêmes au retour en `production`. |
| `AMAZON_SKUS` | Facultatif, à laisser vide. Identifiants de produit acceptés, séparés par des virgules. |
| `AMAZON_GRACE_DAYS` | Facultatif (3 par défaut). Jours d'accès conservés après la fin de période : marge de sécurité si Amazon est injoignable au moment du contrôle. |
| `REVIEWER_PASSWORD_1` / `REVIEWER_PASSWORD_2` | Facultatif. Mots de passe (8 caractères minimum) des deux **comptes de test** des relecteurs d'Amazon, créés par le serveur lui-même (voir 6.6). **Retirez-les après l'approbation** : les comptes sont alors supprimés. |
| `KEEPALIVE_START` / `KEEPALIVE_END` | Heures (0–24) pendant lesquelles le serveur se réveille tout seul (offre gratuite de Render, qui s'endort après 15 min). Mettre `0` et `24` pendant l'examen d'Amazon : si l'application ne démarre pas au moment du test, elle est refusée. Nécessite `API_URL` (adresse publique du serveur). |

Contrôle après déploiement : ouvrez `https://VOTRE-API/amazon/etat` dans un navigateur, il doit afficher `{"pret":true,"relecteurs":2}` (`pret` : la clé Amazon est en place ; `relecteurs` : nombre de comptes de test prêts, 0 si vous n'avez pas défini `REVIEWER_PASSWORD_1` et `_2`).

### 6.2 Routes

- `POST /amazon/verify` accepte **deux formats**.
  - **Format de la page du site** (`spectra-amazon.js`), connexion **facultative** : `{ receiptId, amazonUserId, email? }`. La page vérifie l'achat **avant** que le compte existe. Adresse retenue, dans l'ordre : le compte connecté, l'adresse saisie, le compte déjà rattaché à cet identifiant Amazon. Réponse `200` : `{ active, email, alreadyLinkedToOtherEmail, accountExists, status, currentPeriodEnd, amazon, receiptsToConfirm, cached }` (`alreadyLinkedToOtherEmail` : ce compte Amazon sert déjà une autre adresse, renvoyée **masquée** `a***@gmail.com` ; `accountExists` : un compte Spectra existe déjà pour cette adresse, la page propose « Se connecter » plutôt que « Créer un compte »). Reçu annulé ou terminé : `200 { active:false, code:'AMAZON_RECEIPT_CANCELED' }`. Erreurs : `400 EMAIL_REQUIRED`, `400 AMAZON_INVALID_REQUEST`, `400 AMAZON_RECEIPT_INVALID` (reçu inconnu d'Amazon), `409 AMAZON_OTHER_ACCOUNT` (cette adresse est déjà abonnée via un autre compte Amazon), `503 AMAZON_UNAVAILABLE` (Amazon injoignable : réessayer plus tard, rien n'est accordé ni perdu).
  - **Ancien format** (connexion obligatoire) : `{ userId, receiptIds: [...] }`.
- `POST /auth/register` :
  - **Dans l'application Fire** (User-Agent contenant `SpectraAmazon/`), la création de compte est **libre** : aucun paiement ni code d'invitation n'est exigé. La réponse `201` contient `subscriptionRequired: true` ; l'accès aux fonctions payantes reste fermé tant que `/billing/status` n'est pas actif (la page affiche alors l'écran d'abonnement, voir 6.3). C'est ce qui évite le message d'erreur « paiement requis » que voyait le testeur d'Amazon en appuyant sur « Créer un compte ».
  - Un code d'invitation **saisi mais invalide** (inconnu, déjà utilisé, expiré, ou invitant plus abonné) donne `402 INVITE_INVALID` avec un message qui invite à laisser le champ vide ; aucun compte n'est créé. Un code valide ouvre l'accès tout de suite (`subscriptionRequired: false`).
  - **Sur le site web** (hors application Fire) rien ne change : sans paiement confirmé ni code d'invitation valide, `402 PAYMENT_REQUIRED`.
  - La route accepte aussi `amazon: { userId, receiptIds: [...] }` comme preuve de paiement (ancien format, la page actuelle ne s'en sert plus).
- `GET /billing/status` indique aussi `source` : `stripe`, `amazon` ou `linked`.
- Dans l'application Fire (User-Agent contenant `SpectraAmazon/`), `POST /billing/create-checkout-session` et `/billing/create-portal-session` répondent `403 USE_AMAZON_IAP` : aucun lien Stripe n'est jamais fourni.

### 6.3 Déroulé côté page (`spectra-amazon.js` + `app.html`)

Le pont natif (`SpectraAmazonNative`, événements `window.SpectraAmazon._surNatif`) fournit `userId`, les reçus et gère l'achat. Parcours « compte d'abord » (version 5 du site) :

1. **Nouveau client** : « Créer un compte » (libre, sans erreur) → la page affiche l'**écran d'abonnement** plein écran avec le bouton d'achat Amazon (prix donné par Amazon) → après l'achat, la page envoie `{ receiptId, amazonUserId }` à `/amazon/verify` **avec la session** → le serveur rattache l'abonnement à l'adresse du compte connecté → la page confirme la livraison à Amazon, vérifie `/billing/status` et ouvre l'application. Si Amazon ne renvoie pas le prix, l'écran affiche « L'abonnement n'est pas disponible pour le moment » avec un bouton « Réessayer » (et une nouvelle tentative automatique).
2. **Restauration** (réinstallation, nouvelle tablette) : on se connecte avec son compte, l'abonnement suit le compte. Si le client a créé un autre compte Spectra avec le même compte Amazon, le bouton « Restaurer » lui répond que l'abonnement est déjà lié à `a***@exemple.fr` (adresse masquée) et lui demande de se connecter avec celle-ci.
3. **Achat depuis les réglages**, déjà connecté : le serveur rattache l'abonnement au compte connecté.
4. **Panne ou serveur endormi pendant l'achat** : rien n'est confirmé à Amazon ; au lancement suivant Amazon renvoie le reçu et la page réessaie toute seule.
5. **Résiliation / remboursement** : Amazon signale le reçu annulé à l'application, qui le transmet au serveur ; l'accès est fermé.

### 6.4 Renouvellements et résiliations

Amazon ne renvoie **plus** le reçu d'un abonnement qui continue normalement. Le serveur revérifie donc **lui-même**, auprès d'Amazon, le reçu enregistré, au plus toutes les 12 h et seulement quand quelqu'un ouvre l'application (`isEmailPaid`, `/billing/status`, y compris pour les comptes liés ou invités par un payeur Amazon). Sans cela, l'accès se couperait un mois (+ délai de grâce) après l'achat. En cas de panne d'Amazon, **rien n'est retiré** : l'accès court jusqu'à la fin de la période payée (+ délai de grâce) et le contrôle est retenté plus tard (pause d'une minute entre deux essais).

### 6.5 Règles de sécurité

- Un compte Amazon n'est rattaché qu'à **un seul** e-mail Spectra (sinon un abonnement pourrait ouvrir des comptes sans limite). La suppression du compte libère ce rattachement.
- Un reçu inventé ne révèle rien : la réponse est la même que l'adresse soit abonnée ou non, et l'adresse liée à un compte Amazon n'est jamais montrée en clair à quelqu'un d'autre.
- Un ancien reçu expiré ne coupe jamais un abonnement renouvelé, et un reçu plus ancien ne raccourcit jamais une période déjà vérifiée.
- À la suppression d'un compte, l'utilisateur est prévenu que l'abonnement Amazon **n'est pas résilié automatiquement** (seul le client peut le résilier chez Amazon).
- Les identifiants envoyés par l'application sont strictement contrôlés avant d'être placés dans l'adresse interrogée chez Amazon.
- Limite connue et assumée : quelqu'un qui possède un reçu valide peut rattacher son propre abonnement à l'adresse d'un tiers (le tiers n'y perd rien ; au pire, il ne peut pas rattacher son propre compte Amazon tant que cet abonnement court).

### 6.6 Comptes de test pour les relecteurs d'Amazon

Amazon doit pouvoir se connecter sans rien acheter. Deux comptes de test, `relecteur-amazon-1@example.com` et `relecteur-amazon-2@example.com` (le second sert à tester la suppression de compte ; si un relecteur le supprime, l'autre reste utilisable), sont **créés par le serveur lui-même** (`reviewers.js`) :

1. Dans Render > Environment, ajoutez `REVIEWER_PASSWORD_1` et `REVIEWER_PASSWORD_2` avec **vos propres** mots de passe (8 caractères minimum, dédiés, jamais ceux d'un vrai compte), puis **Save Changes**.
2. Au redémarrage, le serveur crée les deux comptes, abonnés sans limite de durée, avec ces mots de passe. Il les remet en état toutes les 30 minutes (un compte supprimé par un relecteur revient pour le suivant). Rien n'est à saisir dans la base.
3. Vérification : `https://VOTRE-API/amazon/etat` affiche `"relecteurs":2`.
4. **Après l'approbation** : retirez les deux variables dans Render. Au redémarrage suivant, les deux comptes (et leurs données) sont supprimés. Seules ces deux adresses `example.com` (domaine réservé, qui ne peut appartenir à aucun vrai client) sont créées ou supprimées de cette façon.

Les mots de passe ne sont écrits ni dans le code ni dans les journaux.

*Voie manuelle, si vous préférez ne pas utiliser les variables* : collez ceci dans l'éditeur SQL de la base (mots de passe de votre choix) ; le bloc peut être relancé sans danger.

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

INSERT INTO paid_emails (email, status, current_period_end, verified_at)
VALUES ('relecteur-amazon-1@example.com', 'active', '2099-12-31', now()),
       ('relecteur-amazon-2@example.com', 'active', '2099-12-31', now())
ON CONFLICT (email) DO UPDATE
SET status = 'active', current_period_end = '2099-12-31', verified_at = now();

INSERT INTO users (id, email, password_hash, display_name, role)
VALUES (gen_random_uuid()::text, 'relecteur-amazon-1@example.com', crypt('MOT_DE_PASSE_1', gen_salt('bf', 10)), 'Relecteur Amazon 1', 'caregiver'),
       (gen_random_uuid()::text, 'relecteur-amazon-2@example.com', crypt('MOT_DE_PASSE_2', gen_salt('bf', 10)), 'Relecteur Amazon 2', 'caregiver')
ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash;
```

Après l'approbation, supprimez ces comptes avec `DELETE FROM users WHERE email LIKE 'relecteur-amazon-%'` puis `DELETE FROM paid_emails WHERE email LIKE 'relecteur-amazon-%'`. (Si les variables `REVIEWER_PASSWORD_*` sont absentes, le serveur supprime lui-même ces deux comptes à chaque démarrage : la voie manuelle ne tient donc que si ces variables sont définies, ou si le serveur n'est pas redémarré.)

### 6.7 Tests

`DATABASE_URL=... JWT_SECRET=... node test-amazon.js` lance un faux service Amazon et un vrai serveur sur une base de **test** (193 vérifications) : achat valide, annulé, remboursé, renouvelé, panne d'Amazon, clé refusée, délai dépassé, reçu piégé, mode d'essai, course entre deux inscriptions, achat avant création du compte, création de compte libre dans l'appli Fire (code invalide, code valide, site web inchangé), restauration sur une autre tablette, revérification des renouvellements, etc.
