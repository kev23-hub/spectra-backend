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
router.post('/invite', async (req, res) => {
  try {
    const code = generateCode();
    const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    const email = (req.body?.email || '').trim().toLowerCase() || null;

    await db.run(
      'INSERT INTO invite_codes (code, inviter_id, inviter_role, invitee_email, role_label, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      [code, req.user.sub, req.user.role, email, req.body?.roleLabel || '', expiresAt]
    );

    let emailResult = null;
    if (email) {
      const inviter = await db.get('SELECT email FROM users WHERE id = ?', [req.user.sub]);
      emailResult = await sendInviteEmail({ to: email, code, expiresAt, inviterEmail: inviter?.email });
    }
    res.status(201).json({ code, expiresAt, email: emailResult });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur lors de la création de l\'invitation.' });
  }
});

// POST /link/redeem  { code }
router.post('/redeem', async (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code) return res.status(400).json({ error: 'code requis.' });

    const invite = await db.get('SELECT * FROM invite_codes WHERE code = ?', [code.toUpperCase()]);
    if (!invite) return res.status(404).json({ error: 'Code invalide.' });
    if (invite.used_at) return res.status(410).json({ error: 'Ce code a déjà été utilisé.' });
    if (new Date(invite.expires_at) < new Date()) return res.status(410).json({ error: 'Ce code a expiré.' });
    if (!invite.inviter_id) {
      return res.status(400).json({ error: 'Ce code sert à créer un nouveau compte, pas à lier un compte existant.' });
    }
    if (invite.inviter_id === req.user.sub) return res.status(400).json({ error: 'Vous ne pouvez pas utiliser votre propre invitation.' });
    if (invite.inviter_role === req.user.role) {
      return res.status(403).json({ error: 'Ce code a été créé par un compte du même type que le vôtre : il faut un compte "personne" et un compte "aidant" pour se lier.' });
    }

    const personId = invite.inviter_role === 'person' ? invite.inviter_id : req.user.sub;
    const caregiverId = invite.inviter_role === 'caregiver' ? invite.inviter_id : req.user.sub;

    await db.transaction(async (t) => {
      await t.run(
        'INSERT INTO links (id, person_id, caregiver_id, role_label) VALUES (?, ?, ?, ?) ON CONFLICT (person_id, caregiver_id) DO NOTHING',
        [randomUUID(), personId, caregiverId, invite.role_label]
      );
      await t.run('UPDATE invite_codes SET used_at = now() WHERE code = ?', [invite.code]);
    });

    res.json({ linked: true, personId, caregiverId });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur lors de la liaison des comptes.' });
  }
});

// GET /link/mine
router.get('/mine', async (req, res) => {
  const rows = req.user.role === 'person'
    ? await db.query(`SELECT l.id, l.role_label, l.created_at, u.id as caregiver_id, u.display_name, u.email
                      FROM links l JOIN users u ON u.id = l.caregiver_id WHERE l.person_id = ?`, [req.user.sub])
    : await db.query(`SELECT l.id, l.role_label, l.created_at, u.id as person_id, u.display_name, u.email
                      FROM links l JOIN users u ON u.id = l.person_id WHERE l.caregiver_id = ?`, [req.user.sub]);
  res.json({ links: rows });
});

// DELETE /link/:id
router.delete('/:id', async (req, res) => {
  const link = await db.get('SELECT * FROM links WHERE id = ?', [req.params.id]);
  if (!link) return res.status(404).json({ error: 'Lien introuvable.' });
  if (link.person_id !== req.user.sub && link.caregiver_id !== req.user.sub) {
    return res.status(403).json({ error: 'Ce lien ne vous concerne pas.' });
  }
  await db.run('DELETE FROM links WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
