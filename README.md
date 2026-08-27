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
