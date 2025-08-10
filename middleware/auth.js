// middleware/auth.js
const pool = require('../config/db');

async function findUserByToken(token) {
  const res = await pool.query('SELECT * FROM users WHERE proxy_token = $1', [token]);
  return res.rows[0];
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

module.exports = { requireAuth };