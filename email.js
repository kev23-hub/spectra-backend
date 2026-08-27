// Envoi d'e-mails transactionnels via Resend (https://resend.com).
// Resend a ete choisi parce que sa configuration est la plus simple du marche
// pour un projet qui demarre : un compte gratuit, une cle API, un domaine
// verifie (ou leur domaine de test pour commencer). Vous pouvez remplacer
// cette fonction par SendGrid, Postmark ou autre sans toucher au reste du
// code -- seule cette fonction doit changer.
//
// IMPORTANT : RESEND_API_KEY est une cle secrete, comme celle de Stripe.
// Elle ne doit exister que dans votre fichier .env sur le serveur, jamais
// ailleurs (jamais dans le code, jamais partagee dans une conversation).

let resendClient = null;
function getResend() {
  if (!process.env.RESEND_API_KEY) return null;
  if (!resendClient) {
    const { Resend } = require('resend');
    resendClient = new Resend(process.env.RESEND_API_KEY);
  }
  return resendClient;
}

// Envoie l'e-mail d'invitation. Si RESEND_API_KEY n'est pas configuree,
// la fonction ne plante pas : elle log simplement le lien dans la console
// (pratique en developpement, avant d'avoir configure un vrai compte email).
async function sendInviteEmail({ to, code, expiresAt, inviterEmail }) {
  const appUrl = process.env.APP_URL || 'http://localhost:3000';
  const link = `${appUrl}/index.html?invite=${encodeURIComponent(code)}`;
  const resend = getResend();

  if (!resend) {
    console.log(`[email] RESEND_API_KEY absente -- voici le lien qui aurait ete envoye a ${to} :`);
    console.log(`[email] ${link} (code : ${code}, expire le ${expiresAt})`);
    return { sent: false, reason: 'RESEND_API_KEY manquante', link };
  }

  const fromAddress = process.env.RESEND_FROM || 'Spectra <onboarding@resend.dev>';
  try {
    await resend.emails.send({
      from: fromAddress,
      to,
      subject: 'Invitation à rejoindre Spectra',
      html: `
        <p>${inviterEmail ? `${inviterEmail} vous invite` : 'Vous êtes invité(e)'} à rejoindre son espace sur Spectra, l'application d'accompagnement pour l'autisme.</p>
        <p><a href="${link}">Cliquez ici pour accepter l'invitation</a></p>
        <p>Ou entrez ce code manuellement dans l'application : <strong>${code}</strong></p>
        <p style="color:#666;font-size:13px">Ce lien expire le ${new Date(expiresAt).toLocaleDateString('fr-FR')}. Si vous n'attendiez pas cette invitation, ignorez simplement cet e-mail.</p>
      `,
    });
    return { sent: true, link };
  } catch (e) {
    console.error('[email] Echec envoi Resend:', e.message);
    return { sent: false, reason: e.message, link };
  }
}

module.exports = { sendInviteEmail };
