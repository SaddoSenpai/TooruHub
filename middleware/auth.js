// middleware/auth.js
const pool = require('../config/db');
const cache = require('../services/cacheService');

async function findUserByToken(token) {
  const cacheKey = `user:${token}`;
  const cachedUser = cache.get(cacheKey);

  if (cachedUser) {
    console.log(`[Cache] HIT for ${cacheKey}`);
    return cachedUser;
  }

  console.log(`[Cache] MISS for ${cacheKey}`);
  const res = await pool.query('SELECT * FROM users WHERE proxy_token = $1', [token]);
  const user = res.rows[0];

  if (user) {
    cache.set(cacheKey, user); // Store the user object in cache
  }
  return user;
}

function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  const token = auth?.startsWith('Bearer ') ? auth.split(' ')[1].trim() : null;
  
  if (!token) {
    return res.status(401).json({ error: 'Missing Authorization Bearer token' });
  }

  findUserByToken(token).then(user => {
    if (!user) {
      return res.status(401).json({ error: 'Invalid token' });
    }
    req.user = user;
    next();
  }).catch(err => {
    console.error(err);
    res.status(500).json({ error: 'DB error during authentication' });
  });
}

// --- NEW ---
// A more flexible authentication middleware for the proxy routes.
// It allows either a registered user's token OR a guest's provider API key.
async function flexibleAuth(req, res, next) {
  const auth = req.headers.authorization;
  const token = auth?.startsWith('Bearer ') ? auth.split(' ')[1].trim() : null;
  
  if (!token) {
    return res.status(401).json({ error: 'Missing Authorization Bearer token' });
  }

  // Step 1: Try to authenticate as a registered user.
  try {
    const user = await findUserByToken(token);
    if (user) {
      req.user = user; // Attach the full user object.
      console.log(`[Auth] Authenticated as registered user: ${user.username}`);
      return next();
    }
  } catch (err) {
      console.error('DB error during flexible authentication:', err);
      return res.status(500).json({ error: 'Authentication error' });
  }

  // Step 2: If not a registered user, treat the token as a guest API key.
  // We don't validate it here; we just pass it along for the proxy controller to handle.
  req.guest_api_key = token; // Attach the key to a different property.
  console.log('[Auth] Proceeding with guest API key.');
  return next();
}


module.exports = { requireAuth, findUserByToken, flexibleAuth };