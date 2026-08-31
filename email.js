// Envoi d'e-mails transactionnels via Resend (https://resend.com).
//
// IMPORTANT : RESEND_API_KEY est une clé secrète, comme celle de Stripe.
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

function appUrl() {
  return (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
}
function fromAddress() {
  return process.env.RESEND_FROM || 'Spectra <onboarding@resend.dev>';
}

const FOOTER = `<p style="color:#666;font-size:12px;margin-top:24px">
  Spectra — application d'accompagnement pour les personnes autistes et leur entourage.
</p>`;

async function send({ to, subject, html }) {
  const resend = getResend();
  if (!resend) {
    console.log(`[email] RESEND_API_KEY absente — e-mail NON envoyé à ${to} (sujet : ${subject})`);
    return { sent: false, reason: 'RESEND_API_KEY manquante' };
  }
  try {
    await resend.emails.send({ from: fromAddress(), to, subject, html });
    return { sent: true };
  } catch (e) {
    console.error('[email] Échec envoi Resend:', e.message);
    return { sent: false, reason: e.message };
  }
}

// ---------------------------------------------------------------------------
// 1) E-mail envoyé automatiquement APRES un paiement Stripe réussi.
//    Contient : le lien pour créer son compte, le code d'invitation à donner
//    à la personne accompagnée, et le lien de résiliation (exigence légale :
//    la page d'accueil promet un lien de gestion envoyé par e-mail).
// ---------------------------------------------------------------------------
async function sendSubscriptionWelcomeEmail({ to, inviteCode, inviteExpiresAt, manageToken }) {
  const manageLink = `${appUrl()}/billing/manage?token=${encodeURIComponent(manageToken)}`;
  const signupLink = `${appUrl()}/app.html`;
  const expires = inviteExpiresAt
    ? new Date(inviteExpiresAt).toLocaleDateString('fr-FR')
    : null;

  return send({
    to,
    subject: 'Votre abonnement Spectra est actif',
    html: `
      <p>Bonjour,</p>
      <p>Votre abonnement à Spectra est actif. Voici tout ce dont vous avez besoin.</p>

      <h3 style="margin-bottom:4px">1. Créez votre compte</h3>
      <p><a href="${signupLink}">Ouvrir Spectra et créer votre compte</a><br>
      Utilisez bien <strong>cette même adresse e-mail (${to})</strong> : c'est elle qui
      confirme votre paiement.</p>

      <h3 style="margin-bottom:4px">2. Invitez la personne que vous accompagnez</h3>
      <p>Ce code permet à une deuxième personne de créer son compte, sans payer une
      seconde fois :</p>
      <p style="font-size:22px;font-weight:bold;letter-spacing:1px">${inviteCode}</p>
      ${expires ? `<p style="color:#666;font-size:13px">Ce code est valable jusqu'au ${expires}.</p>` : ''}

      <h3 style="margin-bottom:4px">3. Gérer ou résilier votre abonnement</h3>
      <p><a href="${manageLink}">Gérer mon abonnement</a> — vous pouvez y modifier votre
      moyen de paiement ou <strong>résilier à tout moment, sans justification</strong>.
      La résiliation prend effet immédiatement et sans démarche de notre part.</p>
      <p style="color:#666;font-size:13px">Conservez cet e-mail : ce lien reste votre accès
      direct à la résiliation.</p>
      ${FOOTER}
    `,
  });
}

// ---------------------------------------------------------------------------
// 2) E-mail de confirmation de résiliation.
// ---------------------------------------------------------------------------
async function sendCancellationEmail({ to, periodEnd }) {
  const until = periodEnd ? new Date(periodEnd).toLocaleDateString('fr-FR') : null;
  return send({
    to,
    subject: 'Votre abonnement Spectra a été résilié',
    html: `
      <p>Bonjour,</p>
      <p>Votre abonnement Spectra a bien été résilié. Aucun nouveau prélèvement ne sera
      effectué.</p>
      ${until ? `<p>Votre accès reste ouvert jusqu'au ${until}.</p>` : ''}
      <p>Si vous changez d'avis, vous pouvez vous réabonner à tout moment depuis
      <a href="${appUrl()}/index.html#offre">notre site</a>.</p>
      ${FOOTER}
    `,
  });
}

// ---------------------------------------------------------------------------
// 3) E-mail d'invitation envoyé manuellement depuis les Paramètres de l'app.
// ---------------------------------------------------------------------------
async function sendInviteEmail({ to, code, expiresAt, inviterEmail }) {
  const link = `${appUrl()}/app.html?invite=${encodeURIComponent(code)}`;
  const result = await send({
    to,
    subject: 'Invitation à rejoindre Spectra',
    html: `
      <p>${inviterEmail ? `${inviterEmail} vous invite` : 'Vous êtes invité(e)'} à rejoindre
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

module.exports = { sendInviteEmail, sendSubscriptionWelcomeEmail, sendCancellationEmail };
