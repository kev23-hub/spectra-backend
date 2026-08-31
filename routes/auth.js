const express = require('express');
const bcrypt = require('bcryptjs');
const { randomUUID } = require('crypto');
const db = require('../db');
const { signToken, requireAuth } = require('../auth');

const router = express.Router();

// POST /auth/register  { email, password, displayName, role, inviteCode }
// Un compte ne peut être créé que dans deux cas :
//  1) cet email correspond à un paiement Stripe réel et actif ;
//  2) OU un code d'invitation valide a été fourni. Ce code peut venir
//     d'un compte existant (Paramètres > inviter) OU être le code envoyé
//     automatiquement par e-mail juste après le paiement (inviter_id NULL).
router.post('/register', async (req, res) => {
  try {
    const { email, password, displayName, role, inviteCode } = req.body || {};
    if (!email || !password || !role) {
      return res.status(400).json({ error: 'email, password et role sont requis.' });
    }
    if (!['person', 'caregiver'].includes(role)) {
      return res.status(400).json({ error: 'role doit valoir "person" ou "caregiver".' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caractères.' });
    }
    const normalizedEmail = email.toLowerCase();
    const existing = await db.get('SELECT id FROM users WHERE email = ?', [normalizedEmail]);
    if (existing) return res.status(409).json({ error: 'Un compte existe déjà avec cet email.' });

    const { isEmailPaid } = require('./billing');
    let authorized = await isEmailPaid(normalizedEmail);
    let usedInvite = null;

    if (!authorized && inviteCode) {
      const invite = await db.get('SELECT * FROM invite_codes WHERE code = ?', [inviteCode.toUpperCase()]);
      if (invite && !invite.used_at && new Date(invite.expires_at) >= new Date()) {
        if (invite.inviter_id) {
          const inviter = await db.get('SELECT id FROM users WHERE id = ?', [invite.inviter_id]);
          if (inviter) { authorized = true; usedInvite = invite; }
        } else {
          // Code émis automatiquement après un paiement Stripe : on vérifie
          // que l'abonnement de l'acheteur est toujours actif.
          const stillPaid = await isEmailPaid(invite.source_email);
          if (stillPaid) { authorized = true; usedInvite = invite; }
        }
      }
    }

    if (!authorized) {
      return res.status(402).json({
        error: 'Aucun paiement confirmé pour cet email, et aucun code d\'invitation valide fourni. Abonnez-vous d\'abord, ou demandez un code d\'invitation à la personne qui a déjà un compte.',
        code: 'PAYMENT_REQUIRED',
      });
    }

    const id = randomUUID();
    const passwordHash = await bcrypt.hash(password, 10);
    await db.run(
      'INSERT INTO users (id, email, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)',
      [id, normalizedEmail, passwordHash, displayName || '', role]
    );

    if (usedInvite) {
      if (usedInvite.inviter_id && usedInvite.inviter_role && usedInvite.inviter_role !== role) {
        const personId = usedInvite.inviter_role === 'person' ? usedInvite.inviter_id : id;
        const caregiverId = usedInvite.inviter_role === 'caregiver' ? usedInvite.inviter_id : id;
        await db.run(
          'INSERT INTO links (id, person_id, caregiver_id, role_label) VALUES (?, ?, ?, ?) ON CONFLICT (person_id, caregiver_id) DO NOTHING',
          [randomUUID(), personId, caregiverId, usedInvite.role_label || '']
        );
      }
      await db.run('UPDATE invite_codes SET used_at = now() WHERE code = ?', [usedInvite.code]);
    }

    const user = { id, email: normalizedEmail, role };
    res.status(201).json({ token: signToken(user), user: { id, email: user.email, role, displayName: displayName || '' } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur serveur lors de la création du compte.' });
  }
});

// POST /auth/login  { email, password }
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email et password sont requis.' });

    const row = await db.get('SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);
    if (!row) return res.status(401).json({ error: 'Identifiants invalides.' });

    const ok = await bcrypt.compare(password, row.password_hash);
    if (!ok) return res.status(401).json({ error: 'Identifiants invalides.' });

    const user = { id: row.id, email: row.email, role: row.role };
    res.json({ token: signToken(user), user: { id: row.id, email: row.email, role: row.role, displayName: row.display_name } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur serveur lors de la connexion.' });
  }
});

// GET /auth/me
router.get('/me', requireAuth, async (req, res) => {
  const row = await db.get('SELECT id, email, role, display_name FROM users WHERE id = ?', [req.user.sub]);
  if (!row) return res.status(404).json({ error: 'Compte introuvable.' });
  res.json({ user: { id: row.id, email: row.email, role: row.role, displayName: row.display_name } });
});

module.exports = router;
