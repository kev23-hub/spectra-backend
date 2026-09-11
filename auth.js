const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET manquant : definissez-le dans .env avant de demarrer le serveur.');
}

// Secret distinct pour les liens de gestion/resiliation envoyes par e-mail.
// Sans cela, faire tourner JWT_SECRET (apres une fuite par exemple) casserait
// d'un coup TOUS les liens de resiliation deja envoyes aux clients.
const MANAGE_SECRET = process.env.MANAGE_TOKEN_SECRET || JWT_SECRET;

function signToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, email: user.email, kind: 'session' },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
}

// Jeton du lien "gerer mon abonnement" envoye par e-mail.
function signManageToken(customerId) {
  return jwt.sign({ cus: customerId, kind: 'manage' }, MANAGE_SECRET, { expiresIn: '365d' });
}

function verifyManageToken(token) {
  const payload = jwt.verify(token, MANAGE_SECRET);
  if (payload.kind !== 'manage' || !payload.cus) throw new Error('Jeton de gestion invalide.');
  return payload;
}

// Jeton de reinitialisation de mot de passe. Le secret inclut le hash actuel
// du mot de passe : des que le mot de passe change, le lien devient caduc.
// C'est ce qui le rend utilisable une seule fois, sans table supplementaire.
function signResetToken(user) {
  return jwt.sign({ sub: user.id, kind: 'reset' }, JWT_SECRET + user.password_hash, { expiresIn: '1h' });
}

function verifyResetToken(token, passwordHash) {
  const payload = jwt.verify(token, JWT_SECRET + passwordHash);
  if (payload.kind !== 'reset' || !payload.sub) throw new Error('Jeton de reinitialisation invalide.');
  return payload;
}

// Lit le sujet d'un jeton de reinitialisation SANS verifier la signature,
// uniquement pour retrouver l'utilisateur et donc son hash de mot de passe.
// La verification reelle est faite juste apres par verifyResetToken.
function peekSubject(token) {
  const decoded = jwt.decode(token);
  return decoded && decoded.kind === 'reset' ? decoded.sub : null;
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentification requise.' });
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return res.status(401).json({ error: 'Jeton invalide ou expire.' });
  }
  // Un jeton "manage" ou "reset" n'ouvre PAS de session : sans ce controle,
  // il passait comme jeton de session avec un sub vide, ce qui faisait
  // planter les routes qui lisent req.user.email.
  if (!payload.sub || (payload.kind && payload.kind !== 'session')) {
    return res.status(401).json({ error: 'Ce jeton ne permet pas d\'ouvrir une session.' });
  }
  req.user = payload;
  next();
}

module.exports = {
  signToken, requireAuth,
  signManageToken, verifyManageToken,
  signResetToken, verifyResetToken, peekSubject,
};
