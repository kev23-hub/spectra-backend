// Envoi d'e-mails transactionnels via Resend (https://resend.com).
//
// IMPORTANT : RESEND_API_KEY est une cle secrete, comme celle de Stripe.
// Elle ne doit exister que dans les variables d'environnement du serveur.

let resendClient = null;
function getResend() {
  if (!process.env.RESEND_API_KEY) return null;
  if (!resendClient) {
    const { Resend } = require('resend');
    resendClient = new Resend(process.env.RESEND_API_KEY);
  }
  return resendClient;
}

// APP_URL = le site (Vercel) : index.html, app.html.
function appUrl() {
  return (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
}

// API_URL = le serveur (Render) : /billing/manage, /auth/reset.
// Les deux etaient confondus : le lien de resiliation envoye par e-mail
// pointait donc vers une page inexistante du site Vercel.
function apiUrl() {
  return (process.env.API_URL || appUrl()).replace(/\/$/, '');
}

function fromAddress() {
  return process.env.RESEND_FROM || 'Spectra <onboarding@resend.dev>';
}

const FOOTER = `<p style="color:#666;font-size:12px;margin-top:24px">
  Spectra — application d'accompagnement pour les personnes autistes et leur entourage.
</p>`;

// ---------------------------------------------------------------------------
// Deuxieme voie d'envoi : SMTP classique.
//
// POURQUOI : Resend refuse d'envoyer a quelqu'un d'autre que vous tant qu'un
// domaine n'est pas verifie, et verifier un domaine suppose d'en acheter un.
// Un compte e-mail gratuit (Gmail, Outlook, Zoho...) fonctionne en SMTP sans
// domaine et sans frais. C'est moins bon pour la delivrabilite qu'un domaine
// verifie, mais cela fait partir les codes d'invitation, les liens de
// resiliation et les reinitialisations de mot de passe des aujourd'hui.
//
// Gmail : activez la validation en deux etapes, puis creez un "mot de passe
// d'application" (myaccount.google.com/apppasswords) et mettez-le dans
// SMTP_PASS. Le mot de passe habituel du compte ne fonctionne pas.
// Limite Gmail : environ 500 envois par jour, tres au-dela de vos besoins.
// ---------------------------------------------------------------------------
let smtpTransport = null;
function getSmtp() {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  if (!smtpTransport) {
    const nodemailer = require('nodemailer');
    smtpTransport = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT || '465', 10),
      secure: String(process.env.SMTP_SECURE || 'true') !== 'false',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return smtpTransport;
}

async function send({ to, subject, html }) {
  // 1) Resend si un domaine est verifie (meilleure delivrabilite).
  const resend = getResend();
  if (resend) {
    try {
      await resend.emails.send({ from: fromAddress(), to, subject, html });
      return { sent: true, via: 'resend' };
    } catch (e) {
      console.error('[email] Echec Resend:', e.message, '— tentative par SMTP.');
    }
  }
  // 2) SMTP en secours, ou en voie principale si Resend n'est pas configure.
  const smtp = getSmtp();
  if (smtp) {
    try {
      await smtp.sendMail({
        from: process.env.SMTP_FROM || `Spectra <${process.env.SMTP_USER}>`,
        to, subject, html,
      });
      return { sent: true, via: 'smtp' };
    } catch (e) {
      console.error('[email] Echec SMTP:', e.message);
      return { sent: false, reason: e.message };
    }
  }
  console.log(`[email] Aucun envoi configure — e-mail NON envoye a ${to} (sujet : ${subject})`);
  return { sent: false, reason: 'Ni Resend ni SMTP configures' };
}

// ---------------------------------------------------------------------------
// 1) E-mail envoye automatiquement APRES un paiement Stripe reussi.
// ---------------------------------------------------------------------------
async function sendSubscriptionWelcomeEmail({ to, inviteCode, inviteExpiresAt, manageToken }) {
  const manageLink = `${apiUrl()}/billing/manage?token=${encodeURIComponent(manageToken)}`;
  const signupLink = `${appUrl()}/app.html`;
  const expires = inviteExpiresAt ? new Date(inviteExpiresAt).toLocaleDateString('fr-FR') : null;

  return send({
    to,
    subject: 'Votre abonnement Spectra est actif',
    html: `
      <p>Bonjour,</p>
      <p>Votre abonnement a Spectra est actif. Voici tout ce dont vous avez besoin.</p>

      <h3 style="margin-bottom:4px">1. Creez votre compte</h3>
      <p><a href="${signupLink}">Ouvrir Spectra et creer votre compte</a><br>
      Utilisez bien <strong>cette meme adresse e-mail (${to})</strong> : c'est elle qui
      confirme votre paiement.</p>

      <h3 style="margin-bottom:4px">2. Invitez la personne que vous accompagnez</h3>
      <p>Ce code permet a une deuxieme personne de creer son compte, sans payer une
      seconde fois :</p>
      <p style="font-size:22px;font-weight:bold;letter-spacing:1px">${inviteCode}</p>
      ${expires ? `<p style="color:#666;font-size:13px">Ce code est valable jusqu'au ${expires}.</p>` : ''}

      <h3 style="margin-bottom:4px">3. Gerer ou resilier votre abonnement</h3>
      <p><a href="${manageLink}">Gerer mon abonnement</a> — vous pouvez y modifier votre
      moyen de paiement ou <strong>resilier a tout moment, sans justification</strong>.
      La resiliation prend effet immediatement et sans demarche de notre part.</p>
      <p style="color:#666;font-size:13px">Conservez cet e-mail : ce lien reste votre acces
      direct a la resiliation.</p>
      ${FOOTER}
    `,
  });
}

// ---------------------------------------------------------------------------
// 2) Confirmation de resiliation.
// ---------------------------------------------------------------------------
async function sendCancellationEmail({ to, periodEnd }) {
  const until = periodEnd ? new Date(periodEnd).toLocaleDateString('fr-FR') : null;
  return send({
    to,
    subject: 'Votre abonnement Spectra a ete resilie',
    html: `
      <p>Bonjour,</p>
      <p>Votre abonnement Spectra a bien ete resilie. Aucun nouveau prelevement ne sera
      effectue.</p>
      ${until ? `<p>Votre acces reste ouvert jusqu'au ${until}.</p>` : ''}
      <p>Si vous changez d'avis, vous pouvez vous reabonner a tout moment depuis
      <a href="${appUrl()}/index.html#offre">notre site</a>.</p>
      ${FOOTER}
    `,
  });
}

// ---------------------------------------------------------------------------
// 3) Invitation envoyee depuis les Parametres de l'application.
// ---------------------------------------------------------------------------
async function sendInviteEmail({ to, code, expiresAt, inviterEmail }) {
  const link = `${appUrl()}/app.html?invite=${encodeURIComponent(code)}`;
  const result = await send({
    to,
    subject: 'Invitation a rejoindre Spectra',
    html: `
      <p>${inviterEmail ? `${inviterEmail} vous invite` : 'Vous etes invite(e)'} a rejoindre
      son espace sur Spectra, l'application d'accompagnement pour l'autisme.</p>
      <p><a href="${link}">Cliquez ici pour accepter l'invitation</a></p>
      <p>Ou entrez ce code manuellement dans l'application : <strong>${code}</strong></p>
      <p style="color:#666;font-size:13px">Ce lien expire le
      ${new Date(expiresAt).toLocaleDateString('fr-FR')}. Si vous n'attendiez pas cette
      invitation, ignorez simplement cet e-mail.</p>
      ${FOOTER}
    `,
  });
  return { ...result, link };
}

// ---------------------------------------------------------------------------
// 4) Reinitialisation de mot de passe. Sans cette fonction, un client qui
//    oubliait son mot de passe etait definitivement enferme dehors : il ne
//    lui restait que la retrofacturation bancaire.
// ---------------------------------------------------------------------------
async function sendPasswordResetEmail({ to, token }) {
  const link = `${apiUrl()}/auth/reset?token=${encodeURIComponent(token)}`;
  return send({
    to,
    subject: 'Reinitialiser votre mot de passe Spectra',
    html: `
      <p>Bonjour,</p>
      <p>Vous avez demande a reinitialiser le mot de passe de votre compte Spectra.</p>
      <p><a href="${link}">Choisir un nouveau mot de passe</a></p>
      <p style="color:#666;font-size:13px">Ce lien est valable une heure et ne fonctionne
      qu'une seule fois. Si vous n'etes pas a l'origine de cette demande, ignorez cet
      e-mail : votre mot de passe actuel reste valable.</p>
      ${FOOTER}
    `,
  });
}

module.exports = {
  sendInviteEmail,
  sendSubscriptionWelcomeEmail,
  sendCancellationEmail,
  sendPasswordResetEmail,
};
