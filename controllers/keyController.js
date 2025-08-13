// controllers/keyController.js
const pool = require('../config/db');
const axios = require('axios');
const { encrypt, decrypt } = require('../services/cryptoService');
const cache = require('../services/cacheService'); // <-- NEW

// --- NEW: Helper function to clear a user's key caches ---
function clearUserKeyCaches(userId) {
    const providers = ['gemini', 'openai', 'openrouter', 'llm7'];
    const cacheKeys = providers.map(p => `keys:${userId}:${p}`);
    cache.del(cacheKeys);
    console.log(`[Cache] DELETED key caches for user ${userId}: ${cacheKeys.join(', ')}`);
}

exports.addKey = async (req, res) => {
  const { provider, apiKey, name } = req.body || {};
  if (!provider || !apiKey) return res.status(400).json({ error: 'provider and apiKey required' });
  const keyName = name || provider;
  try {
    const encryptedKey = encrypt(apiKey);
    await pool.query(
      `INSERT INTO api_keys (user_id, provider, name, api_key) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, provider, name) DO UPDATE SET api_key = EXCLUDED.api_key, is_active = TRUE, deactivated_at = NULL, deactivation_reason = NULL`,
      [req.user.id, provider, keyName, encryptedKey]
    );
    clearUserKeyCaches(req.user.id); // <-- Invalidate cache
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to store key' });
  }
};

exports.getKeys = async (req, res) => {
  const result = await pool.query('SELECT id, provider, name, created_at, is_active, deactivation_reason FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
  res.json({ keys: result.rows });
};

exports.deleteKey = async (req, res) => {
  const id = req.params.id;
  const result = await pool.query('DELETE FROM api_keys WHERE id = $1 AND user_id = $2', [id, req.user.id]);
  if (result.rowCount === 0) { return res.status(404).json({ error: 'not found' }); }
  clearUserKeyCaches(req.user.id); // <-- Invalidate cache
  res.json({ ok: true });
};

exports.reactivateKey = async (req, res) => {
    const id = req.params.id;
    const result = await pool.query('UPDATE api_keys SET is_active = TRUE, deactivated_at = NULL, deactivation_reason = NULL WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    if (result.rowCount === 0) { return res.status(404).json({ error: 'Key not found or does not belong to user.' }); }
    clearUserKeyCaches(req.user.id); // <-- Invalidate cache
    res.json({ ok: true });
};

exports.deactivateKey = async (req, res) => {
    const id = req.params.id;
    const { reason } = req.body;
    const finalReason = `[Manual] ${reason || 'Deactivated by user.'}`;
    const result = await pool.query(
        'UPDATE api_keys SET is_active = FALSE, deactivated_at = NOW(), deactivation_reason = $1 WHERE id = $2 AND user_id = $3',
        [finalReason, id, req.user.id]
    );
    if (result.rowCount === 0) { return res.status(404).json({ error: 'Key not found or does not belong to user.' }); }
    clearUserKeyCaches(req.user.id); // <-- Invalidate cache
    res.json({ ok: true });
};

exports.testKey = async (req, res) => {
    // ... (this function is unchanged)
    const id = req.params.id;
    try {
        const keyResult = await pool.query('SELECT * FROM api_keys WHERE id = $1 AND user_id = $2', [id, req.user.id]);
        const keyToTest = keyResult.rows[0];
        if (!keyToTest) { return res.status(404).json({ error: 'Key not found.' }); }
        
        const decryptedKey = decrypt(keyToTest.api_key);
        if (decryptedKey === 'DECRYPTION_FAILED') {
            return res.status(500).json({ ok: false, error: 'Key decryption failed. The ENCRYPTION_KEY may have changed.' });
        }

        const { provider } = keyToTest;
        let testPayload, testUrl, headers;

        if (provider === 'gemini') {
            testUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${decryptedKey}`;
            testPayload = { contents: [{ parts: [{ text: "hello" }] }] };
            headers = { 'Content-Type': 'application/json' };
        } else if (provider === 'openai') {
            testUrl = 'https://api.openai.com/v1/chat/completions';
            testPayload = { model: 'gpt-3.5-turbo', messages: [{ role: 'user', content: 'hello' }], max_tokens: 1 };
            headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${decryptedKey}` };
        } else if (provider === 'openrouter') {
            testUrl = 'https://openrouter.ai/api/v1/chat/completions';
            testPayload = { model: 'mistralai/mistral-7b-instruct:free', messages: [{ role: 'user', content: 'hello' }], max_tokens: 1 };
            headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${decryptedKey}` };
        } else if (provider === 'llm7') {
            testUrl = 'https://api.llm7.io/v1/chat/completions';
            testPayload = { model: 'open-mistral-7b', messages: [{ role: 'user', content: 'hello' }], max_tokens: 1 };
            headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${decryptedKey}` };
        } else {
            return res.status(400).json({ error: 'Testing not supported for this provider.' });
        }

        await axios.post(testUrl, testPayload, { headers, timeout: 15000 });
        res.json({ ok: true, message: 'Key is working' });
    } catch (err) {
        console.error(`Key test failed for ID ${id}:`, err.response?.data ?? err.message);
        res.status(400).json({ ok: false, error: 'Key test failed.', detail: err.response?.data ?? err.message });
    }
};