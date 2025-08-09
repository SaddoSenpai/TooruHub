// server.js
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const axios = require('axios');
const path = require('path');
const { Pool } = require('pg'); // Use the PostgreSQL driver

const PORT = process.env.PORT || 3000;
const SALT_ROUNDS = 10;

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- Database init (Supabase/PostgreSQL) ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'YOUR_POOLER_CONNECTION_STRING',
  ssl: {
    rejectUnauthorized: false
  }
});


pool.connect()
  .then(() => console.log('Successfully connected to Supabase database.'))
  .catch(err => console.error('Database connection error', err.stack));


// --- Helpers (Updated for PostgreSQL) ---
function genToken() {
  return crypto.randomBytes(32).toString('hex'); // 64 hex chars
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

// --- Auth endpoints (Updated for PostgreSQL) ---
app.post('/signup', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username & password required' });
  try {
    const existing = await findUserByUsername(username);
    if (existing) return res.status(400).json({ error: 'username already taken' });
    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const token = genToken();
    
    // Use RETURNING id to get the new user's ID
    const result = await pool.query(
      'INSERT INTO users (username, password_hash, proxy_token) VALUES ($1, $2, $3) RETURNING id',
      [username, hash, token]
    );
    const userId = result.rows[0].id;

    // Use Promise.all to run inserts in parallel
    await Promise.all([
      pool.query(`INSERT INTO prompt_blocks (user_id, name, role, content, position, immutable) VALUES ($1, $2, $3, $4, $5, $6)`, [userId, 'Character Info', 'user', '<<PARSED_CHARACTER_INFO>>', 0, 1]),
      pool.query(`INSERT INTO prompt_blocks (user_id, name, role, content, position, immutable) VALUES ($1, $2, $3, $4, $5, $6)`, [userId, 'User Persona', 'user', '<<PARSED_USER_PERSONA>>', 1, 1]),
      pool.query(`INSERT INTO prompt_blocks (user_id, name, role, content, position, immutable) VALUES ($1, $2, $3, $4, $5, $6)`, [userId, 'Chat History', 'user', '<<PARSED_CHAT_HISTORY>>', 2, 1])
    ]);

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

// --- Keys management (Updated for PostgreSQL) ---
app.post('/add-keys', requireAuth, async (req, res) => {
  const { provider, apiKey, name } = req.body || {};
  if (!provider || !apiKey) return res.status(400).json({ error: 'provider and apiKey required' });
  const keyName = name || provider;
  try {
    // Use ON CONFLICT to simplify INSERT or UPDATE logic (UPSERT)
    await pool.query(
      `INSERT INTO api_keys (user_id, provider, name, api_key) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, provider, name) DO UPDATE SET api_key = EXCLUDED.api_key`,
      [req.user.id, provider, keyName, apiKey]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to store key' });
  }
});

app.get('/keys', requireAuth, async (req, res) => {
  const result = await pool.query('SELECT id, provider, name, created_at FROM api_keys WHERE user_id = $1', [req.user.id]);
  res.json({ keys: result.rows });
});

app.delete('/keys/:id', requireAuth, async (req, res) => {
  const id = req.params.id;
  // The query now also checks user_id for security
  const result = await pool.query('DELETE FROM api_keys WHERE id = $1 AND user_id = $2', [id, req.user.id]);
  if (result.rowCount === 0) {
    return res.status(404).json({ error: 'not found' });
  }
  res.json({ ok: true });
});

// --- Prompt blocks (config) endpoints (Updated for PostgreSQL) ---
app.get('/api/config', requireAuth, async (req, res) => {
  const result = await pool.query('SELECT id, name, role, content, position, immutable FROM prompt_blocks WHERE user_id = $1 ORDER BY position', [req.user.id]);
  res.json({ blocks: result.rows });
});

app.post('/api/config', requireAuth, async (req, res) => {
  const { name, role, content } = req.body || {};
  if (!name || !role) return res.status(400).json({ error: 'name and role required' });
  const maxRow = await pool.query('SELECT MAX(position) as mx FROM prompt_blocks WHERE user_id = $1', [req.user.id]);
  const nextPos = (maxRow.rows[0]?.mx ?? -1) + 1;
  await pool.query('INSERT INTO prompt_blocks (user_id, name, role, content, position, immutable) VALUES ($1, $2, $3, $4, $5, $6)',
    [req.user.id, name, role, content || '', nextPos, 0]);
  const blocks = await pool.query('SELECT id, name, role, content, position, immutable FROM prompt_blocks WHERE user_id = $1 ORDER BY position', [req.user.id]);
  res.json({ blocks: blocks.rows });
});

app.put('/api/config/:id', requireAuth, async (req, res) => {
  const id = req.params.id;
  const { name, role, content } = req.body || {};
  // First, verify the block belongs to the user and is not immutable
  const blockCheck = await pool.query('SELECT * FROM prompt_blocks WHERE id = $1 AND user_id = $2', [id, req.user.id]);
  const row = blockCheck.rows[0];
  if (!row) return res.status(404).json({ error: 'not found' });
  if (row.immutable) return res.status(403).json({ error: 'cannot edit immutable block' });
  
  await pool.query('UPDATE prompt_blocks SET name = $1, role = $2, content = $3 WHERE id = $4', [name || row.name, role || row.role, content ?? row.content, id]);
  const blocks = await pool.query('SELECT id, name, role, content, position, immutable FROM prompt_blocks WHERE user_id = $1 ORDER BY position', [req.user.id]);
  res.json({ blocks: blocks.rows });
});

app.delete('/api/config/:id', requireAuth, async (req, res) => {
  const id = req.params.id;
  const blockCheck = await pool.query('SELECT * FROM prompt_blocks WHERE id = $1 AND user_id = $2', [id, req.user.id]);
  if (!blockCheck.rows[0]) return res.status(404).json({ error: 'not found' });
  if (blockCheck.rows[0].immutable) return res.status(403).json({ error: 'cannot delete immutable block' });
  
  await pool.query('DELETE FROM prompt_blocks WHERE id = $1', [id]);
  // Reordering is more complex in pure SQL, but a simple re-fetch and update loop is fine for this scale
  const remaining = await pool.query('SELECT id FROM prompt_blocks WHERE user_id = $1 ORDER BY position', [req.user.id]);
  for (let i = 0; i < remaining.rows.length; i++) {
    await pool.query('UPDATE prompt_blocks SET position = $1 WHERE id = $2', [i, remaining.rows[i].id]);
  }
  const blocks = await pool.query('SELECT id, name, role, content, position, immutable FROM prompt_blocks WHERE user_id = $1 ORDER BY position', [req.user.id]);
  res.json({ blocks: blocks.rows });
});

app.post('/api/config/reorder', requireAuth, async (req, res) => {
  const { order } = req.body || {};
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order array required' });
  
  // This loop is fine for this use case. For very large lists, a single bulk query would be better.
  for (let i = 0; i < order.length; i++) {
    const id = order[i];
    // We don't need to pre-validate IDs if the user can only see their own blocks.
    await pool.query('UPDATE prompt_blocks SET position = $1 WHERE id = $2 AND user_id = $3', [i, id, req.user.id]);
  }
  const blocks = await pool.query('SELECT id, name, role, content, position, immutable FROM prompt_blocks WHERE user_id = $1 ORDER BY position', [req.user.id]);
  res.json({ blocks: blocks.rows });
});

async function getUserKeyForProvider(userId, provider) {
  const res = await pool.query('SELECT * FROM api_keys WHERE user_id = $1 AND provider = $2 ORDER BY created_at DESC LIMIT 1', [userId, provider]);
  return res.rows[0];
}

// --- PROMPT PARSING AND BUILDING LOGIC (No changes needed here) ---
// ... (The entire buildFinalMessages and parseJanitorInput functions remain the same)
async function parseJanitorInput(incomingMessages) {
  let characterName = 'Character';
  let characterInfo = null;
  let userPersona = null;
  let chatHistory = [];

  const fullContent = (incomingMessages || []).map(m => m.content || '').join('\n\n');

  const charRegex = /<([^\s>]+)'s Persona>([\s\S]*?)<\/\1's Persona>/;
  const charMatch = fullContent.match(charRegex);
  if (charMatch) {
    characterName = charMatch[1];
    characterInfo = { role: 'user', content: charMatch[2].trim() };
  }

  const userRegex = /<UserPersona>([\s\S]*?)<\/UserPersona>/;
  const userMatch = fullContent.match(userRegex);
  if (userMatch) {
    userPersona = { role: 'user', content: userMatch[1].trim() };
  }

  chatHistory = (incomingMessages || []).filter(m => {
    const content = m.content || '';
    return !content.includes("'s Persona>") && !content.includes("<UserPersona>");
  });

  return { characterName, characterInfo, userPersona, chatHistory };
}

async function buildFinalMessages(userId, incomingBody) {
  if (incomingBody && incomingBody.bypass_prompt_structure) {
    return incomingBody.messages || [];
  }

  const result = await pool.query('SELECT * FROM prompt_blocks WHERE user_id = $1 ORDER BY position', [userId]);
  const userBlocks = result.rows;
  if (!userBlocks || userBlocks.length === 0) return incomingBody.messages || [];

  const { characterName, characterInfo, userPersona, chatHistory } = await parseJanitorInput(incomingBody.messages);
  
  console.log('--- PARSED DATA ---');
  console.log('Character Name:', characterName);
  console.log('Character Info Found:', !!characterInfo);
  console.log('User Persona Found:', !!userPersona);
  console.log('Chat History Length:', chatHistory.length);
  console.log('--------------------');

  const finalMessages = [];
  for (const block of userBlocks) {
    if (block.immutable) {
      switch (block.name) {
        case 'Character Info':
          if (characterInfo) finalMessages.push(characterInfo);
          break;
        case 'User Persona':
          if (userPersona) finalMessages.push(userPersona);
          break;
        case 'Chat History':
          if (chatHistory.length > 0) finalMessages.push(...chatHistory);
          break;
      }
    } else {
      let customContent = block.content || '';
      customContent = customContent.replace(/{{char}}/g, characterName);
      finalMessages.push({ role: block.role, content: customContent });
    }
  }

  if (finalMessages.length === 0) {
    console.log('[WARNING] buildFinalMessages resulted in an empty array. Falling back to original messages.');
    return incomingBody.messages || [];
  }

  return finalMessages;
}


// --- Proxy endpoint (No changes needed here) ---
// ... (The entire /v1/chat/completions endpoint remains the same)
app.post('/v1/chat/completions', requireAuth, async (req, res) => {
  const reqId = crypto.randomBytes(4).toString('hex');
  console.log(`\n[${new Date().toISOString()}] --- NEW REQUEST ${reqId} ---`);
  
  try {
    const body = req.body || {};
    const model = (body.model || '').toString();

    console.log(`[${reqId}] User ${req.user.id} requesting model: ${model}`);
    console.log(`[${reqId}] RAW INCOMING MESSAGES:`, JSON.stringify(body.messages, null, 2));

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

    const mergedMessages = await buildFinalMessages(req.user.id, body);

    console.log(`[${reqId}] FINAL MESSAGES TO BE SENT (${provider}):`, JSON.stringify(mergedMessages, null, 2));
    if (mergedMessages.length === 0) {
        console.error(`[${reqId}] CRITICAL: Final message array is empty. Aborting call to AI provider.`);
        return res.status(500).json({ error: 'Proxy error: Failed to construct a valid prompt.' });
    }

    // === GEMINI handling ===
    if (provider === 'gemini') {
      let systemInstructionText = '';
      const contents = [];

      (mergedMessages || []).forEach(m => {
        const role = (m.role || 'user').toString();
        if (role === 'system') {
          systemInstructionText += (systemInstructionText ? '\n' : '') + (m.content || '');
        } else if (role === 'assistant') {
          contents.push({ role: 'model', parts: [{ text: m.content || '' }] });
        } else {
          contents.push({ role: 'user', parts: [{ text: m.content || '' }] });
        }
      });

      const safetySettings = Array.isArray(body.safety_settings) ? body.safety_settings : DEFAULT_GEMINI_SAFETY_SETTINGS;
      const generation_config = {
        temperature: body.temperature ?? 0.2,
        top_k: body.top_k ?? undefined,
        top_p: body.top_p ?? 0.95
      };
      const geminiRequestBody = { contents, generation_config, safety_settings: safetySettings };
      if (systemInstructionText) geminiRequestBody.system_instruction = { parts: [{ text: systemInstructionText }] };

      // STREAMING
      if (body.stream) {
        const endpoint = 'streamGenerateContent';
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:${endpoint}?key=${encodeURIComponent(apiKey)}`;
        const providerResp = await axios.post(url, geminiRequestBody, { headers: { 'Content-Type': 'application/json' }, responseType: 'stream', timeout: 120000 });
        console.log(`[${reqId}] Request to Gemini successful. Streaming response...`);
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
                  id: `chatcmpl-${reqId}`,
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
        providerResp.data.on('end', () => { console.log(`[${reqId}] Stream ended.`); res.write('data: [DONE]\n\n'); res.end(); });
        providerResp.data.on('error', (err) => { console.error(`[${reqId}] Gemini stream error`, err); try { res.end(); } catch (e) {} });
        return;
      }

      // NON-STREAMING
      const endpoint = 'generateContent';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:${endpoint}?key=${encodeURIComponent(apiKey)}`;
      const providerResp = await axios.post(url, geminiRequestBody, { headers: { 'Content-Type': 'application/json' }, timeout: 120000 });
      
      const candidate = providerResp.data?.candidates?.[0];
      const candidateText = candidate?.content?.parts?.[0]?.text ?? '';
      const finishReason = candidate?.finishReason || 'stop';

      const responsePayload = {
        id: `chatcmpl-${reqId}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: candidateText },
          finish_reason: finishReason
        }],
        usage: {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0
        }
      };
      
      console.log(`[${reqId}] Sending response back to client:`, JSON.stringify(responsePayload, null, 2));
      return res.json(responsePayload);
    }

    // === OPENROUTER / OPENAI handling ===
    if (provider === 'openrouter' || provider === 'openai') {
      const forwardBody = { ...body };
      forwardBody.messages = mergedMessages;
      
      const forwardUrl = provider === 'openrouter' ? 'https://openrouter.ai/api/v1/chat/completions' : 'https://api.openai.com/v1/chat/completions';
      if (forwardBody.stream) {
        const resp = await axios.post(forwardUrl, forwardBody, { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` }, responseType: 'stream', timeout: 120000 });
        console.log(`[${reqId}] Request to ${provider} successful. Streaming response...`);
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        resp.data.pipe(res);
        resp.data.on('end', () => console.log(`[${reqId}] Stream ended.`));
        return;
      }
      const providerResp = await axios.post(forwardUrl, forwardBody, { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` }, timeout: 120000 });
      console.log(`[${reqId}] Request to ${provider} successful. Sending non-streamed response.`);
      console.log(`[${reqId}] Sending response back to client:`, JSON.stringify(providerResp.data, null, 2));
      return res.status(providerResp.status).json(providerResp.data);
    }

    return res.status(400).json({ error: `Unsupported provider '${provider}'.` });
  } catch (err) {
    console.error(`[${reqId}] --- PROXY ERROR ---`);
    if (err.response) {
      console.error('Error Status:', err.response.status);
      console.error('Error Data:', JSON.stringify(err.response.data, null, 2));
    } else {
      console.error('Error Message:', err.message);
    }
    console.error('--------------------');
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

app.listen(PORT, () => {
  console.log(`AI key proxy server listening on port ${PORT}`);
});