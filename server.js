// server.js
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const axios = require('axios');
const path = require('path');
const { Pool } = require('pg');
const fileUpload = require('express-fileupload');

const PORT = process.env.PORT || 3000;
const SALT_ROUNDS = 10;

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(fileUpload());
app.use(express.static(path.join(__dirname, 'public')));

// --- Database init (Supabase/PostgreSQL) ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'YOUR_SUPABASE_CONNECTION_STRING',
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined
});

pool.connect()
  .then(() => console.log('Successfully connected to Supabase database.'))
  .catch(err => console.error('Database connection error', err.stack));


// --- Key Rotation State (In-Memory) ---
const keyRotationState = {};


// --- Helpers ---
function genToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function findUserByUsername(username) {
  const res = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
  return res.rows[0];
}

async function findUserByToken(token) {
  const res = await pool.query('SELECT * FROM users WHERE proxy_token = $1', [token]);
  return res.rows[0];
}

function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  const token = auth?.startsWith('Bearer ') ? auth.split(' ')[1].trim() : null;
  if (!token) return res.status(401).json({ error: 'Missing Authorization Bearer token' });
  findUserByToken(token).then(user => {
    if (!user) return res.status(401).json({ error: 'Invalid token' });
    req.user = user;
    next();
  }).catch(err => {
    console.error(err);
    res.status(500).json({ error: 'DB error' });
  });
}

// Default Gemini safety settings
const DEFAULT_GEMINI_SAFETY_SETTINGS = [
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" }
];

// --- Auth endpoints ---
app.post('/signup', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username & password required' });
  try {
    const existing = await findUserByUsername(username);
    if (existing) return res.status(400).json({ error: 'username already taken' });
    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const token = genToken();
    
    const result = await pool.query(
      'INSERT INTO users (username, password_hash, proxy_token) VALUES ($1, $2, $3) RETURNING id',
      [username, hash, token]
    );
    const userId = result.rows[0].id;

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
});

app.post('/login', async (req, res) => {
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
});
app.post('/regenerate-token', requireAuth, async (req, res) => {
  const newToken = genToken();
  await pool.query('UPDATE users SET proxy_token = $1 WHERE id = $2', [newToken, req.user.id]);
  res.json({ proxy_token: newToken });
});

// --- Keys management ---
app.post('/add-keys', requireAuth, async (req, res) => {
  const { provider, apiKey, name } = req.body || {};
  if (!provider || !apiKey) return res.status(400).json({ error: 'provider and apiKey required' });
  const keyName = name || provider;
  try {
    await pool.query(
      `INSERT INTO api_keys (user_id, provider, name, api_key) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, provider, name) DO UPDATE SET api_key = EXCLUDED.api_key, is_active = TRUE, deactivated_at = NULL, deactivation_reason = NULL`,
      [req.user.id, provider, keyName, apiKey]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to store key' });
  }
});

app.get('/keys', requireAuth, async (req, res) => {
  const result = await pool.query('SELECT id, provider, name, created_at, is_active, deactivation_reason FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
  res.json({ keys: result.rows });
});

app.delete('/keys/:id', requireAuth, async (req, res) => {
  const id = req.params.id;
  const result = await pool.query('DELETE FROM api_keys WHERE id = $1 AND user_id = $2', [id, req.user.id]);
  if (result.rowCount === 0) {
    return res.status(404).json({ error: 'not found' });
  }
  res.json({ ok: true });
});

app.post('/api/keys/:id/reactivate', requireAuth, async (req, res) => {
    const id = req.params.id;
    const result = await pool.query(
        'UPDATE api_keys SET is_active = TRUE, deactivated_at = NULL, deactivation_reason = NULL WHERE id = $1 AND user_id = $2',
        [id, req.user.id]
    );
    if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Key not found or does not belong to user.' });
    }
    res.json({ ok: true });
});

// NEW: Endpoint to manually deactivate a key
app.post('/api/keys/:id/deactivate', requireAuth, async (req, res) => {
    const id = req.params.id;
    const { reason } = req.body;
    const result = await pool.query(
        'UPDATE api_keys SET is_active = FALSE, deactivated_at = NOW(), deactivation_reason = $1 WHERE id = $2 AND user_id = $3',
        [reason || 'Manually deactivated by user.', id, req.user.id]
    );
    if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Key not found or does not belong to user.' });
    }
    res.json({ ok: true });
});


// --- Config Management Endpoints ---
// ... (These are unchanged)
app.get('/api/configs/meta', requireAuth, async (req, res) => {
    const result = await pool.query('SELECT config_name_1, config_name_2, config_name_3, active_config_slot FROM users WHERE id = $1', [req.user.id]);
    res.json(result.rows[0]);
});
app.put('/api/configs/meta', requireAuth, async (req, res) => {
    const { names } = req.body;
    if (!Array.isArray(names) || names.length !== 3) {
        return res.status(400).json({ error: 'Invalid names array' });
    }
    await pool.query('UPDATE users SET config_name_1 = $1, config_name_2 = $2, config_name_3 = $3 WHERE id = $4', [names[0], names[1], names[2], req.user.id]);
    res.json({ ok: true });
});
app.get('/api/configs/active', requireAuth, async (req, res) => {
    const result = await pool.query('SELECT active_config_slot FROM users WHERE id = $1', [req.user.id]);
    res.json(result.rows[0]);
});
app.put('/api/configs/active', requireAuth, async (req, res) => {
    const { slot } = req.body;
    if (![1, 2, 3].includes(slot)) {
        return res.status(400).json({ error: 'Invalid slot number' });
    }
    await pool.query('UPDATE users SET active_config_slot = $1 WHERE id = $2', [slot, req.user.id]);
    res.json({ ok: true });
});
app.get('/api/configs/export', requireAuth, async (req, res) => {
    const slot = parseInt(req.query.slot, 10);
    if (![1, 2, 3].includes(slot)) return res.status(400).json({ error: 'Invalid slot' });
    const userResult = await pool.query(`SELECT config_name_${slot} as name FROM users WHERE id = $1`, [req.user.id]);
    const configName = userResult.rows[0]?.name || `Config ${slot}`;
    const blocksResult = await pool.query('SELECT name, role, content FROM prompt_blocks WHERE user_id = $1 AND config_slot = $2 ORDER BY position', [req.user.id, slot]);
    const exportData = { configName, blocks: blocksResult.rows.map(b => ({ name: b.name, role: b.role, content: b.content })) };
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${configName.replace(/ /g, '_')}.json"`);
    res.send(JSON.stringify(exportData, null, 2));
});
app.post('/api/configs/import', requireAuth, async (req, res) => {
    const slot = parseInt(req.query.slot, 10);
    if (![1, 2, 3].includes(slot)) return res.status(400).json({ error: 'Invalid slot' });
    if (!req.files || Object.keys(req.files).length === 0) {
        return res.status(400).json({ error: 'No file uploaded.' });
    }
    const client = await pool.connect();
    try {
        const file = req.files.configFile;
        const importData = JSON.parse(file.data.toString('utf8'));
        if (!importData.configName || !Array.isArray(importData.blocks)) { throw new Error('Invalid JSON format'); }
        const fullImportedContent = importData.blocks.map(b => b.content || '').join('');
        if (!fullImportedContent.includes('<<PARSED_CHARACTER_INFO>>') || !fullImportedContent.includes('<<PARSED_USER_PERSONA>>') || !fullImportedContent.includes('<<PARSED_CHAT_HISTORY>>')) {
            throw new Error('Imported config is invalid. It must contain all three placeholders.');
        }
        await client.query('BEGIN');
        await client.query('DELETE FROM prompt_blocks WHERE user_id = $1 AND config_slot = $2', [req.user.id, slot]);
        await client.query(`UPDATE users SET config_name_${slot} = $1 WHERE id = $2`, [importData.configName, req.user.id]);
        for (let i = 0; i < importData.blocks.length; i++) {
            const block = importData.blocks[i];
            await client.query('INSERT INTO prompt_blocks (user_id, config_slot, name, role, content, position) VALUES ($1, $2, $3, $4, $5, $6)', [req.user.id, slot, block.name, block.role, block.content, i]);
        }
        await client.query('COMMIT');
        res.json({ ok: true, newName: importData.configName });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Import error:", err);
        res.status(500).json({ error: 'Failed to import config.', detail: err.message });
    } finally {
        client.release();
    }
});
app.get('/api/config', requireAuth, async (req, res) => {
  const slot = parseInt(req.query.slot, 10) || 1;
  if (![1, 2, 3].includes(slot)) return res.status(400).json({ error: 'Invalid slot' });
  const result = await pool.query('SELECT id, name, role, content, position FROM prompt_blocks WHERE user_id = $1 AND config_slot = $2 ORDER BY position', [req.user.id, slot]);
  res.json({ blocks: result.rows });
});
app.post('/api/config', requireAuth, async (req, res) => {
  const slot = parseInt(req.query.slot, 10) || 1;
  if (![1, 2, 3].includes(slot)) return res.status(400).json({ error: 'Invalid slot' });
  const { name, role, content } = req.body || {};
  if (!name || !role) return res.status(400).json({ error: 'name and role required' });
  const maxRow = await pool.query('SELECT MAX(position) as mx FROM prompt_blocks WHERE user_id = $1 AND config_slot = $2', [req.user.id, slot]);
  const nextPos = (maxRow.rows[0]?.mx ?? -1) + 1;
  await pool.query('INSERT INTO prompt_blocks (user_id, name, role, content, position, config_slot) VALUES ($1, $2, $3, $4, $5, $6)', [req.user.id, name, role, content || '', nextPos, slot]);
  const blocks = await pool.query('SELECT id, name, role, content, position FROM prompt_blocks WHERE user_id = $1 AND config_slot = $2 ORDER BY position', [req.user.id, slot]);
  res.json({ blocks: blocks.rows });
});
app.put('/api/config/:id', requireAuth, async (req, res) => {
  const id = req.params.id;
  const { name, role, content } = req.body || {};
  const blockCheck = await pool.query('SELECT * FROM prompt_blocks WHERE id = $1 AND user_id = $2', [id, req.user.id]);
  const row = blockCheck.rows[0];
  if (!row) return res.status(404).json({ error: 'not found' });
  await pool.query('UPDATE prompt_blocks SET name = $1, role = $2, content = $3 WHERE id = $4', [name || row.name, role || row.role, content ?? row.content, id]);
  const blocks = await pool.query('SELECT id, name, role, content, position FROM prompt_blocks WHERE user_id = $1 AND config_slot = $2 ORDER BY position', [req.user.id, row.config_slot]);
  res.json({ blocks: blocks.rows });
});
app.delete('/api/config/:id', requireAuth, async (req, res) => {
  const id = req.params.id;
  const blockCheck = await pool.query('SELECT * FROM prompt_blocks WHERE id = $1 AND user_id = $2', [id, req.user.id]);
  const row = blockCheck.rows[0];
  if (!row) return res.status(404).json({ error: 'not found' });
  await pool.query('DELETE FROM prompt_blocks WHERE id = $1', [id]);
  const remaining = await pool.query('SELECT id FROM prompt_blocks WHERE user_id = $1 AND config_slot = $2 ORDER BY position', [req.user.id, row.config_slot]);
  for (let i = 0; i < remaining.rows.length; i++) {
    await pool.query('UPDATE prompt_blocks SET position = $1 WHERE id = $2', [i, remaining.rows[i].id]);
  }
  const blocks = await pool.query('SELECT id, name, role, content, position FROM prompt_blocks WHERE user_id = $1 AND config_slot = $2 ORDER BY position', [req.user.id, row.config_slot]);
  res.json({ blocks: blocks.rows });
});
app.post('/api/config/reorder', requireAuth, async (req, res) => {
  const slot = parseInt(req.query.slot, 10) || 1;
  if (![1, 2, 3].includes(slot)) return res.status(400).json({ error: 'Invalid slot' });
  const { order } = req.body || {};
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order array required' });
  for (let i = 0; i < order.length; i++) {
    const id = order[i];
    await pool.query('UPDATE prompt_blocks SET position = $1 WHERE id = $2 AND user_id = $3 AND config_slot = $4', [i, id, req.user.id, slot]);
  }
  const blocks = await pool.query('SELECT id, name, role, content, position FROM prompt_blocks WHERE user_id = $1 AND config_slot = $2 ORDER BY position', [req.user.id, slot]);
  res.json({ blocks: blocks.rows });
});


// --- PROMPT PARSING AND BUILDING LOGIC ---
// ... (This section is unchanged)
async function getRotatingKey(userId, provider) {
    const res = await pool.query('SELECT * FROM api_keys WHERE user_id = $1 AND provider = $2 AND is_active = TRUE ORDER BY id', [userId, provider]);
    const activeKeys = res.rows;
    if (activeKeys.length === 0) return null;
    if (!keyRotationState[userId]) keyRotationState[userId] = {};
    if (keyRotationState[userId][provider] === undefined) keyRotationState[userId][provider] = 0;
    const currentIndex = keyRotationState[userId][provider];
    const selectedKey = activeKeys[currentIndex];
    keyRotationState[userId][provider] = (currentIndex + 1) % activeKeys.length;
    return selectedKey;
}
async function deactivateKey(keyId, reason) {
    console.log(`Deactivating key ${keyId} due to: ${reason}`);
    await pool.query(
        'UPDATE api_keys SET is_active = FALSE, deactivated_at = NOW(), deactivation_reason = $1 WHERE id = $2',
        [reason, keyId]
    );
}
async function parseJanitorInput(incomingMessages) {
  let characterName = 'Character';
  let characterInfo = '';
  let userPersona = '';
  let chatHistory = [];
  const fullContent = (incomingMessages || []).map(m => m.content || '').join('\n\n');
  const charRegex = /<([^\s>]+)'s Persona>([\s\S]*?)<\/\1's Persona>/;
  const charMatch = fullContent.match(charRegex);
  if (charMatch) {
    characterName = charMatch[1];
    characterInfo = charMatch[2].trim();
  }
  const userRegex = /<UserPersona>([\s\S]*?)<\/UserPersona>/;
  const userMatch = fullContent.match(userRegex);
  if (userMatch) {
    userPersona = userMatch[1].trim();
  }
  chatHistory = (incomingMessages || []).filter(m => {
    const content = m.content || '';
    return !content.includes("'s Persona>") && !content.includes("<UserPersona>");
  });
  return { characterName, characterInfo, userPersona, chatHistory };
}
async function buildFinalMessages(userId, incomingBody) {
    const activeSlotResult = await pool.query('SELECT active_config_slot FROM users WHERE id = $1', [userId]);
    const activeSlot = activeSlotResult.rows[0]?.active_config_slot || 1;
    if (incomingBody && incomingBody.bypass_prompt_structure) {
        return incomingBody.messages || [];
    }
    const result = await pool.query('SELECT * FROM prompt_blocks WHERE user_id = $1 AND config_slot = $2 ORDER BY position', [userId, activeSlot]);
    const userBlocks = result.rows;
    if (!userBlocks || userBlocks.length === 0) return incomingBody.messages || [];
    const fullConfigContent = userBlocks.map(b => b.content || '').join('');
    if (!fullConfigContent.includes('<<PARSED_CHARACTER_INFO>>') || !fullConfigContent.includes('<<PARSED_USER_PERSONA>>') || !fullConfigContent.includes('<<PARSED_CHAT_HISTORY>>')) {
        throw new Error('Your active proxy configuration is invalid. It must contain all three placeholders. Please edit it in /config.');
    }
    const { characterName, characterInfo, userPersona, chatHistory } = await parseJanitorInput(incomingBody.messages);
    const finalMessages = [];
    for (const block of userBlocks) {
        let currentContent = block.content || '';
        if (currentContent.includes('<<PARSED_CHAT_HISTORY>>')) {
            const parts = currentContent.split('<<PARSED_CHAT_HISTORY>>');
            const beforeText = parts[0];
            const afterText = parts[1];
            if (beforeText.trim()) {
                let processedBeforeText = beforeText.replace(/{{char}}/g, characterName).replace(/<<PARSED_CHARACTER_INFO>>/g, characterInfo).replace(/<<PARSED_USER_PERSONA>>/g, userPersona);
                finalMessages.push({ role: block.role, content: processedBeforeText });
            }
            finalMessages.push(...chatHistory);
            if (afterText.trim()) {
                let processedAfterText = afterText.replace(/{{char}}/g, characterName).replace(/<<PARSED_CHARACTER_INFO>>/g, characterInfo).replace(/<<PARSED_USER_PERSONA>>/g, userPersona);
                finalMessages.push({ role: block.role, content: processedAfterText });
            }
        } else {
            currentContent = currentContent.replace(/{{char}}/g, characterName).replace(/<<PARSED_CHARACTER_INFO>>/g, characterInfo).replace(/<<PARSED_USER_PERSONA>>/g, userPersona);
            if (currentContent.trim()) {
                finalMessages.push({ role: block.role, content: currentContent });
            }
        }
    }
    if (finalMessages.length === 0) {
        return incomingBody.messages || [];
    }
    return finalMessages;
}


// --- Proxy endpoint ---
app.post('/v1/chat/completions', requireAuth, async (req, res) => {
  const reqId = crypto.randomBytes(4).toString('hex');
  console.log(`\n[${new Date().toISOString()}] --- NEW REQUEST ${reqId} ---`);
  
  let keyToUse = null;
  try {
    const body = req.body || {};
    const model = (body.model || '').toString();

    let provider = body.provider || req.headers['x-provider'];
    if (!provider) {
      if (model.toLowerCase().startsWith('gemini')) provider = 'gemini';
      else if (model.toLowerCase().startsWith('gpt')) provider = 'openai';
      else provider = 'openrouter';
    }

    keyToUse = await getRotatingKey(req.user.id, provider);
    if (!keyToUse) {
      return res.status(400).json({ error: `No active API key available for provider '${provider}'. Please add one or reactivate a rate-limited key.`});
    }
    const apiKey = keyToUse.api_key;
    console.log(`[${reqId}] Using key ID: ${keyToUse.id} for provider: ${provider}`);

    const mergedMessages = await buildFinalMessages(req.user.id, body);

    if (mergedMessages.length === 0) {
        return res.status(500).json({ error: 'Proxy error: Failed to construct a valid prompt.' });
    }

    if (provider === 'gemini') {
      let systemInstructionText = '';
      const contents = [];
      mergedMessages.forEach(m => {
        const role = (m.role || 'user').toString();
        if (role === 'system') {
          systemInstructionText += (systemInstructionText ? '\n' : '') + (m.content || '');
        } else if (role === 'assistant') {
          contents.push({ role: 'model', parts: [{ text: m.content || '' }] });
        } else {
          contents.push({ role: 'user', parts: [{ text: m.content || '' }] });
        }
      });
      const geminiRequestBody = { contents, generation_config: { temperature: body.temperature ?? 0.2, top_k: body.top_k ?? undefined, top_p: body.top_p ?? 0.95 }, safety_settings: body.safety_settings || DEFAULT_GEMINI_SAFETY_SETTINGS };
      if (systemInstructionText) geminiRequestBody.system_instruction = { parts: [{ text: systemInstructionText }] };
      if (body.stream) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?key=${encodeURIComponent(apiKey)}`;
        const providerResp = await axios.post(url, geminiRequestBody, { headers: { 'Content-Type': 'application/json' }, responseType: 'stream', timeout: 120000 });
        res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Connection', 'keep-alive'); res.flushHeaders && res.flushHeaders();
        providerResp.data.on('data', (chunk) => {
          const str = chunk.toString();
          const lines = str.split('\n').map(l => l.trim()).filter(Boolean);
          for (const line of lines) {
            try {
              const parsed = JSON.parse(line);
              const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
              if (text) {
                const formatted = { id: `chatcmpl-${reqId}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ delta: { content: text }, index: 0, finish_reason: null }] };
                res.write(`data: ${JSON.stringify(formatted)}\n\n`);
              }
            } catch (e) {}
          }
        });
        providerResp.data.on('end', () => { res.write('data: [DONE]\n\n'); res.end(); });
        providerResp.data.on('error', (err) => { console.error(`[${reqId}] Gemini stream error`, err); try { res.end(); } catch (e) {} });
        return;
      }
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const providerResp = await axios.post(url, geminiRequestBody, { headers: { 'Content-Type': 'application/json' }, timeout: 120000 });
      const candidate = providerResp.data?.candidates?.[0];
      const responsePayload = { id: `chatcmpl-${reqId}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message: { role: 'assistant', content: candidate?.content?.parts?.[0]?.text ?? '' }, finish_reason: candidate?.finishReason || 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
      return res.json(responsePayload);
    }
    if (provider === 'openrouter' || provider === 'openai') {
      const forwardBody = { ...body, messages: mergedMessages };
      const forwardUrl = provider === 'openrouter' ? 'https://openrouter.ai/api/v1/chat/completions' : 'https://api.openai.com/v1/chat/completions';
      if (forwardBody.stream) {
        const resp = await axios.post(forwardUrl, forwardBody, { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` }, responseType: 'stream', timeout: 120000 });
        res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Connection', 'keep-alive');
        resp.data.pipe(res);
        return;
      }
      const providerResp = await axios.post(forwardUrl, forwardBody, { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` }, timeout: 120000 });
      return res.status(providerResp.status).json(providerResp.data);
    }

    return res.status(400).json({ error: `Unsupported provider '${provider}'.` });
  } catch (err) {
    const errorData = err.response?.data;
    const errorStatus = err.response?.status;
    const errorText = JSON.stringify(errorData);

    if (keyToUse && (errorStatus === 429 || (errorText && errorText.toLowerCase().includes('rate limit exceeded')))) {
        const reason = `[${errorStatus}] ${errorText}`;
        await deactivateKey(keyToUse.id, reason);
    }

    console.error(`[${reqId}] --- PROXY ERROR ---`, err.response?.data ?? err.message);
    const msg = err.response?.data ?? { message: err.message };
    res.status(500).json({ error: 'Proxy failed', detail: msg });
  }
});


app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/config', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'config.html'));
});

// --- Automatic Key Reactivation Job ---
async function reactivateKeys() {
    console.log('Running key reactivation check...');
    try {
        const { rows } = await pool.query("SELECT id, provider, deactivated_at FROM api_keys WHERE is_active = FALSE AND deactivated_at IS NOT NULL");
        if (rows.length === 0) {
            console.log('No keys to reactivate.');
            return;
        }

        const now = new Date();
        const nowUTC = now.toISOString().split('T')[0];
        const nowPST = new Date(now.getTime() - 8 * 60 * 60 * 1000).toISOString().split('T')[0];

        const keysToReactivate = [];
        for (const key of rows) {
            const deactivatedDateUTC = new Date(key.deactivated_at).toISOString().split('T')[0];
            const deactivatedDatePST = new Date(new Date(key.deactivated_at).getTime() - 8 * 60 * 60 * 1000).toISOString().split('T')[0];

            if (key.provider === 'gemini' && nowPST > deactivatedDatePST) {
                keysToReactivate.push(key.id);
            } else if (key.provider === 'openrouter' && nowUTC > deactivatedDateUTC) {
                keysToReactivate.push(key.id);
            }
        }

        if (keysToReactivate.length > 0) {
            console.log(`Reactivating keys: ${keysToReactivate.join(', ')}`);
            await pool.query(
                'UPDATE api_keys SET is_active = TRUE, deactivated_at = NULL, deactivation_reason = NULL WHERE id = ANY($1::int[])',
                [keysToReactivate]
            );
        }
    } catch (err) {
        console.error('Error during key reactivation job:', err);
    }
}

console.log('Performing initial key reactivation check on startup...');
reactivateKeys();
setInterval(reactivateKeys, 60 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`AI key proxy server listening on port ${PORT}`);
});