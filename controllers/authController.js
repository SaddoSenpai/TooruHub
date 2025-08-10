// controllers/authController.js
const bcrypt = require('bcrypt');
const pool = require('../config/db');
const { genToken } = require('../utils/helpers');

const SALT_ROUNDS = 10;

async function findUserByUsername(username) {
  const res = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
  return res.rows[0];
}

exports.signup = async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username & password required' });
  
  try {
    const existing = await findUserByUsername(username);
    if (existing) return res.status(400).json({ error: 'username already taken' });

    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const token = genToken();
    const result = await pool.query('INSERT INTO users (username, password_hash, proxy_token) VALUES ($1, $2, $3) RETURNING id', [username, hash, token]);
    const userId = result.rows[0].id;

    // Create default prompt blocks for all 3 slots
    for (let slot = 1; slot <= 3; slot++) {
        await Promise.all([
            pool.query(`INSERT INTO prompt_blocks (user_id, name, role, content, position, config_slot) VALUES ($1, $2, $3, $4, $5, $6)`, [userId, 'Character Info Block', 'user', '<<PARSED_CHARACTER_INFO>>', 0, slot]),
            pool.query(`INSERT INTO prompt_blocks (user_id, name, role, content, position, config_slot) VALUES ($1, $2, $3, $4, $5, $6)`, [userId, 'User Persona Block', 'user', '<<PARSED_USER_PERSONA>>', 1, slot]),
            pool.query(`INSERT INTO prompt_blocks (user_id, name, role, content, position, config_slot) VALUES ($1, $2, $3, $4, $5, $6)`, [userId, 'Chat History Block', 'user', '<<PARSED_CHAT_HISTORY>>', 2, slot])
        ]);
    }
    res.json({ username, proxy_token: token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create user' });
  }
};

exports.login = async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username & password required' });

  try {
    const user = await findUserByUsername(username);
    if (!user) return res.status(401).json({ error: 'invalid credentials' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'invalid credentials' });

    res.json({ username: user.username, proxy_token: user.proxy_token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
};

exports.regenerateToken = async (req, res) => {
  const newToken = genToken();
  await pool.query('UPDATE users SET proxy_token = $1 WHERE id = $2', [newToken, req.user.id]);
  res.json({ proxy_token: newToken });
};