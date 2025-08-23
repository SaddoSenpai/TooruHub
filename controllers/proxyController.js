// controllers/proxyController.js
const crypto = require('crypto');
const axios = require('axios');
const { Transform } = require('stream');
const keyService = require('../services/keyService');
const promptService =require('../services/promptService');
const { decrypt } = require('../services/cryptoService');
const statsService = require('../services/statsService');
const { logGuestKeyUsage } = require('../services/guestUsageService');

exports.handleProxyRequest = async (req, res) => {
  statsService.incrementRequestCount();
  const reqId = crypto.randomBytes(4).toString('hex');
  console.log(`\n[${new Date().toISOString()}] --- NEW REQUEST ${reqId} ---`);
  
  const isRegisteredUser = !!req.user;
  const isGuestUser = !!req.guest_api_key;

  if (!isRegisteredUser && !isGuestUser) {
      return res.status(401).json({ error: 'Invalid Authorization token.' });
  }

  let rotatingKeyInfo = null;
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
        const ip = req.ip || req.connection.remoteAddress;
        await logGuestKeyUsage(req.guest_api_key, provider, ip);
        
        apiKeyToUse = req.guest_api_key;
        
        const guestUserObject = { use_predefined_structure: true };
        finalMessages = await promptService.buildFinalMessages(null, body, guestUserObject, provider);
    }

    const keyIdForLogging = isRegisteredUser ? rotatingKeyInfo.id : 'guest';
    console.log(`[${reqId}] Using key ID: ${keyIdForLogging} for provider: ${provider}`);

    if (finalMessages.length === 0) {
      return res.status(500).json({ error: 'TooruHub error: Failed to construct a valid prompt.' });
    }
    
    if (provider === 'gemini') {
      const contents = finalMessages.map(m => {
        const role = (m.role || 'user').toString();
        let geminiRole;

        if (role === 'assistant') {
            geminiRole = 'model';
        } else {
            geminiRole = 'user';
        }

        return {
            role: geminiRole,
            parts: [{ text: m.content || '' }]
        };
      });

      const geminiRequestBody = {
        contents,
        generation_config: { 
            temperature: body.temperature, 
            top_k: body.top_k ?? 5, 
            top_p: body.top_p ?? 1 
        },
        safety_settings: body.safety_settings || promptService.DEFAULT_GEMINI_SAFETY_SETTINGS
      };

      if (body.stream) {
        console.log(`[${reqId}] Initializing Gemini stream...`);
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?key=${encodeURIComponent(apiKeyToUse)}&alt=sse`;
        const providerResp = await axios.post(url, geminiRequestBody, { headers: { 'Content-Type': 'application/json' }, responseType: 'stream', timeout: 120000 });
        
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders && res.flushHeaders();

        let buffer = '';
        providerResp.data.on('data', (chunk) => {
          buffer += chunk.toString();
          let newlineIndex;
          while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
            const line = buffer.substring(0, newlineIndex).trim();
            buffer = buffer.substring(newlineIndex + 1);

            if (line.startsWith('data: ')) {
              const jsonStr = line.substring(6).trim();
              if (jsonStr) {
                try {
                  const parsed = JSON.parse(jsonStr);
                  const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
                  
                  if (text) {
                    const formatted = { id: `chatcmpl-${reqId}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ delta: { content: text }, index: 0, finish_reason: null }] };
                    res.write(`data: ${JSON.stringify(formatted)}\n\n`);
                  }
                } catch (e) {
                  console.error(`[${reqId}] Error parsing Gemini stream JSON:`, jsonStr, e);
                }
              }
            }
          }
        });

        providerResp.data.on('end', () => {
          console.log(`[${reqId}] Gemini stream ended.`);
          res.write('data: [DONE]\n\n');
          res.end();
        });

        providerResp.data.on('error', (err) => {
          console.error(`[${reqId}] Gemini stream connection error:`, err);
          try { res.end(); } catch (e) {}
        });
        
        return;
      } else {
        console.log(`[${reqId}] Initializing Gemini non-streaming request...`);
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKeyToUse)}`;
        const providerResp = await axios.post(url, geminiRequestBody, { headers: { 'Content-Type': 'application/json' }, timeout: 120000 });
        
        const candidate = providerResp.data?.candidates?.[0];
        const responseText = candidate?.content?.parts?.[0]?.text ?? '';

        const responsePayload = { 
            id: `chatcmpl-${reqId}`, 
            object: 'chat.completion', 
            created: Math.floor(Date.now() / 1000), 
            model, 
            choices: [{ 
                index: 0, 
                message: { role: 'assistant', content: responseText }, 
                finish_reason: candidate?.finishReason || 'stop' 
            }], 
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } 
        };
        
        return res.json(responsePayload);
      }
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

    const errorStatus = err.response?.status;
    
    let errorTextForCheck = '';
    if (err.response?.data) {
        try {
            errorTextForCheck = JSON.stringify(err.response.data);
        } catch (stringifyError) {
            errorTextForCheck = err.message || 'Complex stream error';
        }
    } else {
        errorTextForCheck = err.message;
    }

    if (isRegisteredUser && rotatingKeyInfo && provider !== 'llm7' && (errorStatus === 429 || (errorTextForCheck && errorTextForCheck.toLowerCase().includes('rate limit exceeded')))) {
        const reason = `[${errorStatus}] ${errorTextForCheck.substring(0, 250)}`;
        await keyService.deactivateKey(rotatingKeyInfo.id, reason);
    }

    console.error(`[${reqId}] --- PROXY ERROR ---`);
    console.error(`[${reqId}] Message: ${err.message}`);
    if (err.response) {
        console.error(`[${reqId}] Response Status: ${err.response.status}`);
        if (err.response.data && typeof err.response.data.pipe === 'function') {
            console.error(`[${reqId}] Response Data: [Stream Object - not logging full content]`);
        } else {
            console.error(`[${reqId}] Response Data:`, err.response.data);
        }
    }
    
    // --- THIS IS THE DEFINITIVE ANTI-CRASH FIX ---
    // We create a sanitized, safe object to send back to the user,
    // as the raw error object can contain circular references that crash Express's res.json().
    let safeErrorDetail;
    if (err.response?.data) {
        // If the error data is a stream or something complex, don't send it.
        if (typeof err.response.data.pipe === 'function') {
            safeErrorDetail = { error: "Stream error from provider", message: "The connection to the provider failed, which may be due to an invalid API key, rate limits, or a network issue." };
        } else {
            // Otherwise, it's likely a valid JSON error from the API, which is safe to send.
            safeErrorDetail = err.response.data;
        }
    } else {
        // Fallback if there's no response data at all.
        safeErrorDetail = { message: err.message };
    }

    const finalErrorPayload = { error: 'TooruHub request failed', detail: safeErrorDetail };
    
    if (!res.headersSent) {
        res.status(errorStatus || 500).json(finalErrorPayload);
    }
    // --- END OF FIX ---
  }
};

function createDeepseekThinkFilter() {
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