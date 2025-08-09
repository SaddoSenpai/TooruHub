// server.js
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const axios = require('axios');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const PORT = process.env.PORT || 3000;
const SALT_ROUNDS = 10;

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- Database init (SQLite) ---
let db;
(async () => {
  db = await open({ filename: './data.db', driver: sqlite3.Database });
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      password_hash TEXT,
      proxy_token TEXT
    );
  `);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      provider TEXT,
      name TEXT,
      api_key TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, provider, name),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS prompt_blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      name TEXT,
      role TEXT,
      content TEXT,
      position INTEGER,
      immutable INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);
})();

// --- Helpers ---
function genToken() {
  return crypto.randomBytes(32).toString('hex'); // 64 hex chars
}

async function findUserByUsername(username) {
  return await db.get('SELECT * FROM users WHERE username = ?', username);
}

async function findUserByToken(token) {
  return await db.get('SELECT * FROM users WHERE proxy_token = ?', token);
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

// Default Gemini safety settings (from your inspiration file)
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
    const result = await db.run('INSERT INTO users (username, password_hash, proxy_token) VALUES (?, ?, ?)', username, hash, token);
    const userId = result.lastID;

    // Create default immutable JanitorAI block at position 0
    await db.run(
      `INSERT INTO prompt_blocks (user_id, name, role, content, position, immutable) VALUES (?, ?, ?, ?, ?, ?)`,
      userId, 'JanitorAI Default (Cannot change)', 'user', '<<EXTERNAL_INPUT_PLACEHOLDER>>', 0, 1
    );

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
  await db.run('UPDATE users SET proxy_token = ? WHERE id = ?', newToken, req.user.id);
  res.json({ proxy_token: newToken });
});

// --- Keys management ---
app.post('/add-keys', requireAuth, async (req, res) => {
  const { provider, apiKey, name } = req.body || {};
  if (!provider || !apiKey) return res.status(400).json({ error: 'provider and apiKey required' });
  const keyName = name || provider;
  try {
    const existing = await db.get('SELECT id FROM api_keys WHERE user_id = ? AND provider = ? AND name = ?', req.user.id, provider, keyName);
    if (existing) {
      await db.run('UPDATE api_keys SET api_key = ? WHERE id = ?', apiKey, existing.id);
    } else {
      await db.run('INSERT INTO api_keys (user_id, provider, name, api_key) VALUES (?, ?, ?, ?)', req.user.id, provider, keyName, apiKey);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to store key' });
  }
});

app.get('/keys', requireAuth, async (req, res) => {
  const rows = await db.all('SELECT id, provider, name, created_at FROM api_keys WHERE user_id = ?', req.user.id);
  res.json({ keys: rows });
});

app.delete('/keys/:id', requireAuth, async (req, res) => {
  const id = req.params.id;
  const row = await db.get('SELECT * FROM api_keys WHERE id = ? AND user_id = ?', id, req.user.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  await db.run('DELETE FROM api_keys WHERE id = ?', id);
  res.json({ ok: true });
});

// --- Prompt blocks (config) endpoints ---
// Get prompt blocks ordered
app.get('/config', requireAuth, async (req, res) => {
  const rows = await db.all('SELECT id, name, role, content, position, immutable FROM prompt_blocks WHERE user_id = ? ORDER BY position', req.user.id);
  res.json({ blocks: rows });
});

// Add a block (appends to end). role: 'system'|'user'|'assistant'
app.post('/config', requireAuth, async (req, res) => {
  const { name, role, content } = req.body || {};
  if (!name || !role) return res.status(400).json({ error: 'name and role required' });

  // get max position
  const maxRow = await db.get('SELECT MAX(position) as mx FROM prompt_blocks WHERE user_id = ?', req.user.id);
  const nextPos = (maxRow?.mx ?? 0) + 1;
  await db.run('INSERT INTO prompt_blocks (user_id, name, role, content, position, immutable) VALUES (?, ?, ?, ?, ?, ?)',
    req.user.id, name, role, content || '', nextPos, 0);
  const blocks = await db.all('SELECT id, name, role, content, position, immutable FROM prompt_blocks WHERE user_id = ? ORDER BY position', req.user.id);
  res.json({ blocks });
});

// Update a block (cannot update immutable)
app.put('/config/:id', requireAuth, async (req, res) => {
  const id = req.params.id;
  const { name, role, content } = req.body || {};
  const row = await db.get('SELECT * FROM prompt_blocks WHERE id = ? AND user_id = ?', id, req.user.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  if (row.immutable) return res.status(403).json({ error: 'cannot edit immutable block' });
  await db.run('UPDATE prompt_blocks SET name = ?, role = ?, content = ? WHERE id = ?', name || row.name, role || row.role, content ?? row.content, id);
  const blocks = await db.all('SELECT id, name, role, content, position, immutable FROM prompt_blocks WHERE user_id = ? ORDER BY position', req.user.id);
  res.json({ blocks });
});

// Delete a block (cannot delete immutable)
app.delete('/config/:id', requireAuth, async (req, res) => {
  const id = req.params.id;
  const row = await db.get('SELECT * FROM prompt_blocks WHERE id = ? AND user_id = ?', id, req.user.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  if (row.immutable) return res.status(403).json({ error: 'cannot delete immutable block' });
  await db.run('DELETE FROM prompt_blocks WHERE id = ?', id);
  // reorder positions to be contiguous
  const remaining = await db.all('SELECT id FROM prompt_blocks WHERE user_id = ? ORDER BY position', req.user.id);
  for (let i = 0; i < remaining.length; i++) {
    await db.run('UPDATE prompt_blocks SET position = ? WHERE id = ?', i, remaining[i].id);
  }
  const blocks = await db.all('SELECT id, name, role, content, position, immutable FROM prompt_blocks WHERE user_id = ? ORDER BY position', req.user.id);
  res.json({ blocks });
});

// Reorder endpoint: body { order: [id1, id2, ...] }
app.post('/config/reorder', requireAuth, async (req, res) => {
  const { order } = req.body || {};
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order array required' });
  // ensure all ids belong to user
  const rows = await db.all('SELECT id FROM prompt_blocks WHERE user_id = ?', req.user.id);
  const validIds = new Set(rows.map(r => r.id));
  for (let i = 0; i < order.length; i++) {
    const id = order[i];
    if (!validIds.has(id)) return res.status(400).json({ error: `invalid block id ${id}` });
    await db.run('UPDATE prompt_blocks SET position = ? WHERE id = ?', i, id);
  }
  const blocks = await db.all('SELECT id, name, role, content, position, immutable FROM prompt_blocks WHERE user_id = ? ORDER BY position', req.user.id);
  res.json({ blocks });
});

async function getUserKeyForProvider(userId, provider) {
  return await db.get('SELECT * FROM api_keys WHERE user_id = ? AND provider = ? ORDER BY created_at DESC LIMIT 1', userId, provider);
}

// Build final messages using prompt blocks
// If bypassPromptStructure === true -> return body.messages (raw)
// Otherwise: assemble blocks in position order. When encountering the immutable placeholder block
// (JanitorAI Default), we inject the incoming body.messages (if present) or {role:'user', content: body.input}.
async function buildFinalMessages(userId, incomingBody) {
  if (incomingBody && incomingBody.bypass_prompt_structure) {
    // Return raw messages if provided (fall back to empty array)
    return incomingBody.messages || [];
  }

  const blocks = await db.all('SELECT * FROM prompt_blocks WHERE user_id = ? ORDER BY position', userId);
  // if no blocks, fallback to incoming messages
  if (!blocks || blocks.length === 0) return incomingBody.messages || [];

  const final = [];
  for (const b of blocks) {
    if (b.immutable) {
      // Inject external input at this position
      if (Array.isArray(incomingBody.messages) && incomingBody.messages.length > 0) {
        // append all incoming messages in order
        for (const m of incomingBody.messages) final.push({ role: m.role || 'user', content: m.content || '' });
      } else if (typeof incomingBody.input === 'string') {
        final.push({ role: 'user', content: incomingBody.input });
      } else {
        // If the placeholder block itself has content other than the placeholder, include it
        if (b.content && b.content !== '<<EXTERNAL_INPUT_PLACEHOLDER>>') {
          final.push({ role: b.role || 'user', content: b.content || '' });
        } else {
          // nothing to inject; skip
        }
      }
    } else {
      final.push({ role: b.role || 'user', content: b.content || '' });
    }
  }
  return final;
}

// --- Proxy endpoint with streaming and prompt-structure support ---
app.post('/v1/chat/completions', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const model = (body.model || '').toString();

    // Infer provider if not given
    let provider = body.provider || req.headers['x-provider'];
    if (!provider) {
      if (model.toLowerCase().startsWith('gemini')) provider = 'gemini';
      else if (model.toLowerCase().startsWith('gpt')) provider = 'openai';
      else provider = 'openrouter';
    }

    const keyRow = await getUserKeyForProvider(req.user.id, provider);
    if (!keyRow) {
      return res.status(400).json({ error: `No API key stored for provider '${provider}'. Add it at /add-keys.`});
    }
    const apiKey = keyRow.api_key;

    // Build final messages (merges prompt-blocks and client's messages)
    const mergedMessages = await buildFinalMessages(req.user.id, body);

    // === GEMINI handling ===
    if (provider === 'gemini') {
      // Build Gemini-specific request from mergedMessages
      let systemInstructionText = '';
      const contents = [];

      (mergedMessages || []).forEach(m => {
        const role = (m.role || 'user').toString();
        if (role === 'system') {
          systemInstructionText += (systemInstructionText ? '\n' : '') + (m.content || '');
        } else if (role === 'assistant') {
          // assistant -> model
          contents.push({ role: 'model', parts: [{ text: m.content || '' }] });
        } else {
          contents.push({ role: 'user', parts: [{ text: m.content || '' }] });
        }
      });

      // safety settings
      const safetySettings = Array.isArray(body.safety_settings) ? body.safety_settings : DEFAULT_GEMINI_SAFETY_SETTINGS;

      const generation_config = {
        temperature: body.temperature ?? 0.2,
        top_k: body.top_k ?? undefined,
        top_p: body.top_p ?? 0.95
      };

      const geminiRequestBody = {
        contents,
        generation_config,
        safety_settings: safetySettings
      };
      if (systemInstructionText) geminiRequestBody.system_instruction = { parts: [{ text: systemInstructionText }] };

      // STREAMING
      if (body.stream) {
        const endpoint = 'streamGenerateContent';
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:${endpoint}?key=${encodeURIComponent(apiKey)}`;

        const providerResp = await axios.post(url, geminiRequestBody, {
          headers: { 'Content-Type': 'application/json' },
          responseType: 'stream',
          timeout: 120000
        });

        // SSE headers
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders && res.flushHeaders();

        providerResp.data.on('data', (chunk) => {
          const str = chunk.toString();
          const lines = str.split('\n').map(l => l.trim()).filter(Boolean);
          for (const line of lines) {
            try {
              const parsed = JSON.parse(line);
              const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
              if (text) {
                const formatted = {
                  id: `chatcmpl-${Date.now()}`,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model,
                  choices: [{ delta: { content: text }, index: 0, finish_reason: null }]
                };
                res.write(`data: ${JSON.stringify(formatted)}\n\n`);
              }
            } catch (e) { /* ignore non-json fragments */ }
          }
        });

        providerResp.data.on('end', () => {
          res.write('data: [DONE]\n\n');
          res.end();
        });

        providerResp.data.on('error', (err) => {
          console.error('Gemini stream error', err);
          try { res.write('data: [DONE]\n\n'); res.end(); } catch (e) {}
        });

        return;
      }

      // NON-STREAMING
      const endpoint = 'generateContent';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:${endpoint}?key=${encodeURIComponent(apiKey)}`;

      const providerResp = await axios.post(url, geminiRequestBody, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 120000
      });

      const candidateText = providerResp.data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      return res.json({
        id: `proxy-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ message: { role: 'assistant', content: candidateText }, finish_reason: 'stop' }],
        raw: providerResp.data
      });
    }

    // === OPENROUTER / OPENAI handling ===
    if (provider === 'openrouter' || provider === 'openai') {
      // Convert mergedMessages into body.messages for OpenAI/OpenRouter if not bypassing
      const forwardBody = { ...body };
      if (!body.bypass_prompt_structure) {
        forwardBody.messages = mergedMessages;
      }

      const forwardUrl = provider === 'openrouter'
        ? 'https://openrouter.ai/api/v1/chat/completions'
        : 'https://api.openai.com/v1/chat/completions';

      if (forwardBody.stream) {
        const resp = await axios.post(forwardUrl, forwardBody, {
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
          responseType: 'stream',
          timeout: 120000
        });

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        resp.data.pipe(res);
        return;
      }

      const providerResp = await axios.post(forwardUrl, forwardBody, {
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        timeout: 120000
      });
      return res.status(providerResp.status).json(providerResp.data);
    }

    return res.status(400).json({ error: `Unsupported provider '${provider}'.` });
  } catch (err) {
    console.error('Proxy error', err.response?.data ?? err.message);
    const msg = err.response?.data ?? { message: err.message };
    res.status(500).json({ error: 'Proxy failed', detail: msg });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// serve config page
app.get('/config', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'config.html'));
});

app.listen(PORT, () => {
  console.log(`AI key proxy server listening on port ${PORT}`);
});