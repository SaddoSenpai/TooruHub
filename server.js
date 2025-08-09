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

// --- Auth endpoints ---
app.post('/signup', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username & password required' });
  try {
    const existing = await findUserByUsername(username);
    if (existing) return res.status(400).json({ error: 'username already taken' });
    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const token = genToken();
    await db.run('INSERT INTO users (username, password_hash, proxy_token) VALUES (?, ?, ?)', username, hash, token);
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

// Regenerate proxy token
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

async function getUserKeyForProvider(userId, provider) {
  return await db.get('SELECT * FROM api_keys WHERE user_id = ? AND provider = ? ORDER BY created_at DESC LIMIT 1', userId, provider);
}

// Default safety settings used for Gemini (same as in the inspiration file)
const DEFAULT_GEMINI_SAFETY_SETTINGS = [
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" }
];

// --- Proxy endpoint with streaming support ---
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

    // === GEMINI handling ===
    if (provider === 'gemini') {
      const messages = body.messages || [];
      let systemInstructionText = '';
      const contents = [];

      // Collect system instruction if present and turn other roles into gemini roles
      messages.forEach(m => {
        const role = (m.role || 'user').toString();
        if (role === 'system') {
          systemInstructionText += (systemInstructionText ? '\n' : '') + (m.content || '');
        } else if (role === 'assistant') {
          contents.push({ role: 'model', parts: [{ text: m.content || '' }] });
        } else {
          // anything else (user) -> 'user'
          contents.push({ role: 'user', parts: [{ text: m.content || '' }] });
        }
      });

      // Allow overriding safety_settings from the incoming body
      const safetySettings = Array.isArray(body.safety_settings) ? body.safety_settings : DEFAULT_GEMINI_SAFETY_SETTINGS;

      const generation_config = {
        temperature: body.temperature ?? 0.2,
        top_k: body.top_k ?? undefined,
        top_p: body.top_p ?? 0.95
      };

      // Build the request body using the snake_case keys Gemini expects
      const geminiRequestBody = {
        contents,
        generation_config,
        safety_settings: safetySettings
      };

      if (systemInstructionText) {
        geminiRequestBody.system_instruction = { parts: [{ text: systemInstructionText }] };
      }

      // STREAMING
      if (body.stream) {
        // streaming endpoint
        const endpoint = 'streamGenerateContent';
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:${endpoint}?key=${encodeURIComponent(apiKey)}`;

        const providerResp = await axios.post(url, geminiRequestBody, {
          headers: { 'Content-Type': 'application/json' },
          responseType: 'stream',
          timeout: 120000
        });

        // Setup SSE headers
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders && res.flushHeaders();

        // Stream parser - read chunks and attempt to parse JSON objects; for each candidate chunk, emit SSE
        providerResp.data.on('data', (chunk) => {
          const str = chunk.toString();
          // Gemini streaming often sends JSON objects separated by newlines or concatenated.
          // Split on newlines and try to parse each non-empty line as JSON.
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
            } catch (e) {
              // It's common to receive non-JSON fragments. Ignore parsing errors.
            }
          }
        });

        providerResp.data.on('end', () => {
          res.write('data: [DONE]\n\n');
          res.end();
        });

        providerResp.data.on('error', (err) => {
          console.error('Gemini stream error', err);
          // If headers not sent as SSE, send JSON error; otherwise close stream
          try {
            res.write('data: [DONE]\n\n');
            res.end();
          } catch (e) {
            // no-op
          }
        });

        return; // streaming handled
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
      const forwardUrl = provider === 'openrouter'
        ? 'https://openrouter.ai/api/v1/chat/completions'
        : 'https://api.openai.com/v1/chat/completions';

      // If streaming requested, forward the stream and pipe it directly.
      if (body.stream) {
        const resp = await axios.post(forwardUrl, body, {
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

      // Non-streaming forward
      const providerResp = await axios.post(forwardUrl, body, {
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

app.listen(PORT, () => {
  console.log(`AI key proxy server listening on port ${PORT}`);
});