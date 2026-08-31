const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();
router.use(requireAuth);

// Un aidant ne peut jamais lire/écrire les données PRIVEES d'une personne :
// seules les données "shared" sont accessibles, et seulement s'il est lié.
async function resolveOwner(req, res, { requireShared }) {
  const personId = req.query.personId || req.body?.personId;
  if (!personId || personId === req.user.sub) return req.user.sub;

  if (req.user.role !== 'caregiver') {
    res.status(403).json({ error: 'Seul un compte aidant peut consulter les données d\'une autre personne.' });
    return null;
  }
  if (requireShared === false) {
    res.status(403).json({ error: 'Un aidant ne peut pas accéder aux données privées de la personne.' });
    return null;
  }
  const link = await db.get('SELECT 1 FROM links WHERE person_id = ? AND caregiver_id = ?', [personId, req.user.sub]);
  if (!link) {
    res.status(403).json({ error: 'Aucun lien actif avec cette personne.' });
    return null;
  }
  return personId;
}

// GET /sync/:key?shared=1&personId=...
router.get('/:key', async (req, res) => {
  try {
    const shared = (req.query.shared === '1' || req.query.shared === 'true') ? 1 : 0;
    const ownerId = await resolveOwner(req, res, { requireShared: !!shared });
    if (!ownerId) return;

    const row = await db.get(
      'SELECT value, updated_at FROM kv_store WHERE owner_id = ? AND key = ? AND shared = ?',
      [ownerId, req.params.key, shared]
    );
    if (!row) return res.json({ key: req.params.key, value: null });
    res.json({ key: req.params.key, value: JSON.parse(row.value), updatedAt: row.updated_at });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur de lecture.' });
  }
});

// POST /sync/:key  { value, shared, personId }
router.post('/:key', async (req, res) => {
  try {
    const shared = req.body?.shared ? 1 : 0;
    const ownerId = await resolveOwner(req, res, { requireShared: !!shared });
    if (!ownerId) return;
    if (req.body?.value === undefined) return res.status(400).json({ error: 'value requis.' });

    await db.run(`
      INSERT INTO kv_store (owner_id, key, shared, value, updated_at, updated_by)
      VALUES (?, ?, ?, ?, now(), ?)
      ON CONFLICT (owner_id, key, shared) DO UPDATE SET
        value = EXCLUDED.value, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by
    `, [ownerId, req.params.key, shared, JSON.stringify(req.body.value), req.user.sub]);

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur d\'écriture.' });
  }
});

module.exports = router;
