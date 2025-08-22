// controllers/proxyController.js
const crypto = require('crypto');
const axios = require('axios');
const { Transform } = require('stream');
const keyService = require('../services/keyService');
const promptService =require('../services/promptService');
const { decrypt } = require('../services/cryptoService');
const statsService = require('../services/statsService');
const { logGuestKeyUsage } = require('../services/guestUsageService'); // <-- NEW

exports.handleProxyRequest = async (req, res) => {
  statsService.incrementRequestCount();
  const reqId = crypto.randomBytes(4).toString('hex');
  console.log(`\n[${new Date().toISOString()}] --- NEW REQUEST ${reqId} ---`);
  
  // Determine if it's a registered user or a guest
  const isRegisteredUser = !!req.user;
  const isGuestUser = !!req.guest_api_key;

  if (!isRegisteredUser && !isGuestUser) {
      return res.status(401).json({ error: 'Invalid Authorization token.' });
  }

  let rotatingKeyInfo = null; // To hold the key object for registered users
  let provider;

  try {
    const body = req.body || {};
    const model = (body.model || '').toString();
    const modelLower = model.toLowerCase();
    
    provider = req.provider_from_route || body.provider || req.headers['x-provider'];
    if (!provider) {
      if (modelLower.startsWith('gemini')) provider = 'gemini';
      else if (modelLower.startsWith('gpt')) provider = 'openai';
      else if (modelLower === 'deepseek-chat' || modelLower === 'deepseek-reasoner') provider = 'deepseek';
      else provider = 'openrouter';
    }

    let apiKeyToUse;
    let finalMessages;
    let userIdForLogging = isRegisteredUser ? req.user.id : 'guest';
    console.log(`[${reqId}] User ${userIdForLogging} requesting model: ${model} via provider: ${provider}`);

    if (isRegisteredUser) {
        // --- PATH 1: REGISTERED USER (Existing Logic) ---
        rotatingKeyInfo = await keyService.getRotatingKey(req.user.id, provider);
        if (!rotatingKeyInfo) {
          return res.status(400).json({ error: `No active API key available for provider '${provider}'. Please add one or reactivate a rate-limited key.`});
        }
        
        const decryptedKey = decrypt(rotatingKeyInfo.api_key);
        if (decryptedKey === 'DECRYPTION_FAILED') {
            console.error(`[${reqId}] FATAL: Decryption failed for key ID ${rotatingKeyInfo.id}. The ENCRYPTION_KEY on the server may have changed.`);
            return res.status(500).json({ error: 'Internal Server Error: Could not process API key.' });
        }
        apiKeyToUse = decryptedKey;
        
        finalMessages = await promptService.buildFinalMessages(req.user.id, body, req.user, provider);

    } else { // isGuestUser
        // --- PATH 2: GUEST USER (New Logic) ---
        const ip = req.ip || req.connection.remoteAddress;
        await logGuestKeyUsage(req.guest_api_key, provider, ip);
        
        apiKeyToUse = req.guest_api_key;
        
        // Guest users ALWAYS use the pre-defined structure.
        const guestUserObject = { use_predefined_structure: true };
        finalMessages = await promptService.buildFinalMessages(null, body, guestUserObject, provider);
    }

    const keyIdForLogging = isRegisteredUser ? rotatingKeyInfo.id : 'guest';
    console.log(`[${reqId}] Using key ID: ${keyIdForLogging} for provider: ${provider}`);

    if (finalMessages.length === 0) {
      return res.status(500).json({ error: 'TooruHub error: Failed to construct a valid prompt.' });
    }
    
    // --- COMMON PROXY LOGIC ---
    if (provider === 'gemini') {
      // ... (Gemini logic remains the same, just use `apiKeyToUse` instead of `apiKey`)
      // For brevity, this block is condensed. The internal logic is identical.
      // Ensure you replace `apiKey` with `apiKeyToUse` in the Gemini URLs.
      const url = `...key=${encodeURIComponent(apiKeyToUse)}`;
      // ...
    }

    if (provider === 'openrouter' || provider === 'openai' || provider === 'llm7' || provider === 'deepseek') {
      const forwardBody = { ...body, messages: finalMessages, top_p: body.top_p ?? 1, top_k: body.top_k ?? 5 };
      let forwardUrl;
      if (provider === 'openrouter') forwardUrl = 'https://openrouter.ai/api/v1/chat/completions';
      else if (provider === 'openai') forwardUrl = 'https://api.openai.com/v1/chat/completions';
      else if (provider === 'llm7') forwardUrl = 'https://api.llm7.io/v1/chat/completions';
      else if (provider === 'deepseek') forwardUrl = 'https://api.deepseek.com/chat/completions';
      
      const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKeyToUse}` };

      if (forwardBody.stream) {
        const resp = await axios.post(forwardUrl, forwardBody, { headers, responseType: 'stream', timeout: 120000 });
        res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Connection', 'keep-alive');
        let finalStream = resp.data;
        if (provider === 'deepseek' && modelLower === 'deepseek-reasoner' && req.user && !req.user.show_think_tags) {
            finalStream = finalStream.pipe(createDeepseekThinkFilter());
        }
        finalStream.pipe(res);
        return;
      }

      const providerResp = await axios.post(forwardUrl, forwardBody, { headers, timeout: 120000 });
      let responseData = providerResp.data;
      if (provider === 'deepseek' && modelLower === 'deepseek-reasoner') {
          const content = responseData.choices?.[0]?.message?.content;
          if (content) {
              responseData.choices[0].message.content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
          }
      }
      return res.status(providerResp.status).json(responseData);
    }

    return res.status(400).json({ error: `Unsupported provider '${provider}'.` });

  } catch (err) {
    if (err.name === 'UserInputError') {
        console.warn(`[${reqId}] User input error: ${err.message}`);
        return res.status(400).json({ error: 'Invalid command usage', detail: err.message });
    }

    const errorData = err.response?.data;
    const errorStatus = err.response?.status;
    const errorText = JSON.stringify(errorData);

    // MODIFIED: Only deactivate keys for registered users.
    if (isRegisteredUser && rotatingKeyInfo && provider !== 'llm7' && (errorStatus === 429 || (errorText && errorText.toLowerCase().includes('rate limit exceeded')))) {
        const reason = `[${errorStatus}] ${errorText}`;
        await keyService.deactivateKey(rotatingKeyInfo.id, reason);
    }

    const logError = { message: err.message, isAxiosError: err.isAxiosError, request: err.config ? { method: err.config.method, url: err.config.url } : undefined, response: err.response ? { status: err.response.status, data: err.response.data } : undefined };
    console.error(`[${reqId}] --- PROXY ERROR ---`, JSON.stringify(logError, null, 2));
    
    const finalErrorPayload = { error: 'TooruHub request failed', detail: err.response?.data ?? { message: err.message } };
    res.status(errorStatus || 500).json(finalErrorPayload);
  }
};

function createDeepseekThinkFilter() {
    // ... (This function remains unchanged)
    console.log(`Applying <think> tag filter for deepseek-reasoner stream.`);
    let buffer = '';
    let isInsideThinkTag = false;
    return new Transform({
        transform(chunk, encoding, callback) {
            buffer += chunk.toString();
            let output = '';
            while (true) {
                if (isInsideThinkTag) {
                    const endTagIndex = buffer.indexOf('</think>');
                    if (endTagIndex !== -1) {
                        buffer = buffer.substring(endTagIndex + 8);
                        isInsideThinkTag = false;
                    } else { break; }
                } else {
                    const startTagIndex = buffer.indexOf('<think>');
                    if (startTagIndex !== -1) {
                        output += buffer.substring(0, startTagIndex);
                        buffer = buffer.substring(startTagIndex);
                        isInsideThinkTag = true;
                    } else {
                        output += buffer;
                        buffer = '';
                        break;
                    }
                }
            }
            this.push(output);
            callback();
        }
    });
}