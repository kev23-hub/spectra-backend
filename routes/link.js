const express = require('express');
const { randomUUID, randomBytes } = require('crypto');
const db = require('../db');
const { requireAuth } = require('../auth');
const { sendInviteEmail } = require('../email');

const router = express.Router();
router.use(requireAuth);

function generateCode() {
  return 'SPEC-' + randomBytes(3).toString('hex').toUpperCase();
}

// POST /link/invite  { roleLabel, email }
// N'importe quel compte (personne OU aidant) peut generer une invitation :
// c'est le role INVERSE qui pourra l'utiliser. Si "email" est fourni, un vrai
// e-mail est envoye (voir email.js) ; sinon le code est juste renvoye pour
// que vous le partagiez vous-meme (SMS, en personne...).
router.post('/invite', async (req, res) => {
  const code = generateCode();
  const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  const email = (req.body?.email || '').trim().toLowerCase() || null;

  db.prepare(
    'INSERT INTO invite_codes (code, inviter_id, inviter_role, invitee_email, role_label, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(code, req.user.sub, req.user.role, email, req.body?.roleLabel || '', expiresAt);

  let emailResult = null;
  if (email) {
    const inviter = db.prepare('SELECT email FROM users WHERE id = ?').get(req.user.sub);
    emailResult = await sendInviteEmail({ to: email, code, expiresAt, inviterEmail: inviter?.email });
  }

  res.status(201).json({ code, expiresAt, email: emailResult });
});

// POST /link/redeem  { code }
// Le compte qui utilise le code doit avoir le role OPPOSE de celui qui l'a cree.
router.post('/redeem', (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'code requis.' });

  const invite = db.prepare('SELECT * FROM invite_codes WHERE code = ?').get(code.toUpperCase());
  if (!invite) return res.status(404).json({ error: 'Code invalide.' });
  if (invite.used_at) return res.status(410).json({ error: 'Ce code a deja ete utilise.' });
  if (new Date(invite.expires_at) < new Date()) return res.status(410).json({ error: 'Ce code a expire.' });
  if (invite.inviter_id === req.user.sub) return res.status(400).json({ error: 'Vous ne pouvez pas utiliser votre propre invitation.' });
  if (invite.inviter_role === req.user.role) {
    return res.status(403).json({ error: 'Ce code a ete cree par un compte du meme type que le vôtre (deux personnes, ou deux aidants) : il faut un compte "personne" et un compte "aidant" pour se lier.' });
  }

  const personId = invite.inviter_role === 'person' ? invite.inviter_id : req.user.sub;
  const caregiverId = invite.inviter_role === 'caregiver' ? invite.inviter_id : req.user.sub;

  const linkId = randomUUID();
  const tx = db.transaction(() => {
    db.prepare(
      'INSERT OR IGNORE INTO links (id, person_id, caregiver_id, role_label) VALUES (?, ?, ?, ?)'
    ).run(linkId, personId, caregiverId, invite.role_label);
    db.prepare('UPDATE invite_codes SET used_at = datetime(\'now\') WHERE code = ?').run(invite.code);
  });
  tx();

  res.json({ linked: true, personId, caregiverId });
});

// GET /link/mine  -- liste les liens de l'utilisateur connecte, dans un sens ou dans l'autre
router.get('/mine', (req, res) => {
  const rows = req.user.role === 'person'
    ? db.prepare(`SELECT l.id, l.role_label, l.created_at, u.id as caregiver_id, u.display_name, u.email
                  FROM links l JOIN users u ON u.id = l.caregiver_id WHERE l.person_id = ?`).all(req.user.sub)
    : db.prepare(`SELECT l.id, l.role_label, l.created_at, u.id as person_id, u.display_name, u.email
                  FROM links l JOIN users u ON u.id = l.person_id WHERE l.caregiver_id = ?`).all(req.user.sub);
  res.json({ links: rows });
});

// DELETE /link/:id  -- rompre un lien (accessible aux deux parties du lien)
router.delete('/:id', (req, res) => {
  const link = db.prepare('SELECT * FROM links WHERE id = ?').get(req.params.id);
  if (!link) return res.status(404).json({ error: 'Lien introuvable.' });
  if (link.person_id !== req.user.sub && link.caregiver_id !== req.user.sub) {
    return res.status(403).json({ error: 'Ce lien ne vous appartient pas.' });
  }
  db.prepare('DELETE FROM links WHERE id = ?').run(req.params.id);
  res.json({ deleted: true });
});

module.exports = router;
