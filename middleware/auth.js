// middleware/auth.js
const pool = require('../config/db');
const cache = require('../services/cacheService'); // <-- NEW

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

module.exports = { requireAuth, findUserByToken }; // <-- MODIFIED: Export findUserByToken for use elsewhere