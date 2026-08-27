const express = require('express');
const bcrypt = require('bcryptjs');
const { randomUUID } = require('crypto');
const db = require('../db');
const { signToken, requireAuth } = require('../auth');

const router = express.Router();

// POST /auth/register  { email, password, displayName, role: 'person'|'caregiver', inviteCode }
// Un compte ne peut etre cree que dans deux cas :
//  1) cet email correspond a un paiement Stripe reel et actif (voir paid_emails,
//     alimentee uniquement par le webhook /billing/webhook -- jamais falsifiable
//     depuis le navigateur) ;
//  2) OU un code d'invitation valide, non expire, non utilise, a ete fourni --
//     ce qui permet a la personne ET a l'aidant d'acceder tous les deux a
//     l'application a partir d'un seul paiement, sans payer chacun de son cote.
router.post('/register', async (req, res) => {
  const { email, password, displayName, role, inviteCode } = req.body || {};
  if (!email || !password || !role) {
    return res.status(400).json({ error: 'email, password et role sont requis.' });
  }
  if (!['person', 'caregiver'].includes(role)) {
    return res.status(400).json({ error: 'role doit valoir "person" ou "caregiver".' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caracteres.' });
  }
  const normalizedEmail = email.toLowerCase();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail);
  if (existing) return res.status(409).json({ error: 'Un compte existe deja avec cet email.' });

  const { isEmailPaid } = require('./billing');
  let authorized = isEmailPaid(normalizedEmail);
  let usedInvite = null;

  if (!authorized && inviteCode) {
    const invite = db.prepare('SELECT * FROM invite_codes WHERE code = ?').get(inviteCode.toUpperCase());
    if (invite && !invite.used_at && new Date(invite.expires_at) >= new Date()) {
      // Le code doit avoir ete cree par quelqu'un qui a lui-meme paye (directement
      // ou parce qu'il a ete invite dans la meme chaine) -- on verifie ici que
      // l'auteur de l'invitation est un compte deja existant, donc deja valide
      // au moment de sa propre inscription. On ne verifie pas le role oppose ici
      // (ca reste verifie dans /link/redeem au moment de la liaison) : ce champ
      // sert uniquement a autoriser la creation du compte.
      const inviter = db.prepare('SELECT id FROM users WHERE id = ?').get(invite.inviter_id);
      if (inviter) { authorized = true; usedInvite = invite; }
    }
  }

  if (!authorized) {
    return res.status(402).json({
      error: 'Aucun paiement confirme pour cet email, et aucun code d\'invitation valide fourni. Abonnez-vous d\'abord, ou demandez un code d\'invitation a la personne qui a deja un compte.',
      code: 'PAYMENT_REQUIRED',
    });
  }

  const id = randomUUID();
  const passwordHash = await bcrypt.hash(password, 10);
  db.prepare(
    'INSERT INTO users (id, email, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)'
  ).run(id, normalizedEmail, passwordHash, displayName || '', role);

  // Si l'inscription a ete autorisee via un code d'invitation, on lie
  // immediatement les deux comptes (plus besoin de re-saisir le code apres coup).
  if (usedInvite) {
    const personId = usedInvite.inviter_role === 'person' ? usedInvite.inviter_id : id;
    const caregiverId = usedInvite.inviter_role === 'caregiver' ? usedInvite.inviter_id : id;
    if (usedInvite.inviter_role !== role) {
      db.prepare('INSERT OR IGNORE INTO links (id, person_id, caregiver_id, role_label) VALUES (?, ?, ?, ?)')
        .run(randomUUID(), personId, caregiverId, usedInvite.role_label || '');
      db.prepare('UPDATE invite_codes SET used_at = datetime(\'now\') WHERE code = ?').run(usedInvite.code);
    }
  }

  const user = { id, email: normalizedEmail, role };
  res.status(201).json({ token: signToken(user), user: { id, email: user.email, role, displayName: displayName || '' } });
});

// POST /auth/login  { email, password }
router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email et password sont requis.' });

  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
  if (!row) return res.status(401).json({ error: 'Identifiants invalides.' });

  const ok = await bcrypt.compare(password, row.password_hash);
  if (!ok) return res.status(401).json({ error: 'Identifiants invalides.' });

  const user = { id: row.id, email: row.email, role: row.role };
  res.json({ token: signToken(user), user: { id: row.id, email: row.email, role: row.role, displayName: row.display_name } });
});

// GET /auth/me  -- verifie le jeton et renvoie le profil courant (utilise au
// demarrage de l'app pour restaurer une session sans redemander le mot de passe).
router.get('/me', requireAuth, (req, res) => {
  const row = db.prepare('SELECT id, email, role, display_name FROM users WHERE id = ?').get(req.user.sub);
  if (!row) return res.status(404).json({ error: 'Compte introuvable.' });
  res.json({ user: { id: row.id, email: row.email, role: row.role, displayName: row.display_name } });
});

module.exports = router;
