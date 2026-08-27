const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();
router.use(requireAuth);

// Verifie qu'un compte "caregiver" est bien lie a la personne visee, et
// n'autorise jamais un aidant a lire/ecrire les donnees PRIVEES d'une personne :
// seules les donnees marquees "shared" (equivalent du shared=true cote app)
// sont accessibles a un aidant lie. C'est la meme regle d'autonomie que celle
// deja appliquee cote client dans index.html (reglage "Partager avec l'entourage").
function resolveOwner(req, res, { requireShared }) {
  const personId = req.query.personId || req.body?.personId;
  if (!personId || personId === req.user.sub) {
    return req.user.sub; // chacun gere ses propres donnees, y compris un aidant pour lui-meme
  }
  if (req.user.role !== 'caregiver') {
    res.status(403).json({ error: 'Seul un compte aidant peut consulter les donnees d\'une autre personne.' });
    return null;
  }
  if (requireShared === false) {
    res.status(403).json({ error: 'Un aidant ne peut pas acceder aux donnees privees de la personne.' });
    return null;
  }
  const link = db.prepare('SELECT 1 FROM links WHERE person_id = ? AND caregiver_id = ?').get(personId, req.user.sub);
  if (!link) {
    res.status(403).json({ error: 'Aucun lien actif avec cette personne.' });
    return null;
  }
  return personId;
}

// GET /sync/:key?shared=1&personId=...
router.get('/:key', (req, res) => {
  const shared = req.query.shared === '1' || req.query.shared === 'true' ? 1 : 0;
  const ownerId = resolveOwner(req, res, { requireShared: !!shared });
  if (!ownerId) return; // reponse deja envoyee par resolveOwner

  const row = db.prepare('SELECT value, updated_at FROM kv_store WHERE owner_id = ? AND key = ? AND shared = ?')
    .get(ownerId, req.params.key, shared);
  if (!row) return res.json({ key: req.params.key, value: null });
  res.json({ key: req.params.key, value: JSON.parse(row.value), updatedAt: row.updated_at });
});

// POST /sync/:key  { value, shared, personId }
router.post('/:key', (req, res) => {
  const shared = req.body?.shared ? 1 : 0;
  const ownerId = resolveOwner(req, res, { requireShared: !!shared });
  if (!ownerId) return;
  if (req.body?.value === undefined) return res.status(400).json({ error: 'value requis.' });

  db.prepare(`
    INSERT INTO kv_store (owner_id, key, shared, value, updated_at, updated_by)
    VALUES (?, ?, ?, ?, datetime('now'), ?)
    ON CONFLICT(owner_id, key, shared) DO UPDATE SET
      value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by
  `).run(ownerId, req.params.key, shared, JSON.stringify(req.body.value), req.user.sub);

  res.json({ ok: true });
});

module.exports = router;
