// controllers/proxyController.js
const crypto = require('crypto');
const axios = require('axios');
const keyService = require('../services/keyService');
const promptService =require('../services/promptService');
const { decrypt } = require('../services/cryptoService');
const statsService = require('../services/statsService');

exports.handleProxyRequest = async (req, res) => {
  statsService.incrementRequestCount();
  const reqId = crypto.randomBytes(4).toString('hex');
  console.log(`\n[${new Date().toISOString()}] --- NEW REQUEST ${reqId} ---`);
  let keyToUse = null;
  let provider;

  try {
    const body = req.body || {};
    const model = (body.model || '').toString();
    console.log(`[${reqId}] User ${req.user.id} requesting model: ${model}`);
    console.log(`[${reqId}] RAW INCOMING MESSAGES:`, JSON.stringify(body.messages, null, 2));

    provider = req.provider_from_route || body.provider || req.headers['x-provider'];
    if (!provider) {
      if (model.toLowerCase().startsWith('gemini')) provider = 'gemini';
      else if (model.toLowerCase().startsWith('gpt')) provider = 'openai';
      else provider = 'openrouter';
    }

    keyToUse = await keyService.getRotatingKey(req.user.id, provider);
    if (!keyToUse) {
      return res.status(400).json({ error: `No active API key available for provider '${provider}'. Please add one or reactivate a rate-limited key.`});
    }
    
    const apiKey = decrypt(keyToUse.api_key);
    if (apiKey === 'DECRYPTION_FAILED') {
        console.error(`[${reqId}] FATAL: Decryption failed for key ID ${keyToUse.id}. The ENCRYPTION_KEY on the server may have changed.`);
        return res.status(500).json({ error: 'Internal Server Error: Could not process API key.' });
    }

    console.log(`[${reqId}] Using key ID: ${keyToUse.id} for provider: ${provider}`);

    const mergedMessages = await promptService.buildFinalMessages(req.user.id, body);
    console.log(`[${reqId}] FINAL MESSAGES TO BE SENT (${provider}):`, JSON.stringify(mergedMessages, null, 2));
    if (mergedMessages.length === 0) {
      return res.status(500).json({ error: 'TooruHub error: Failed to construct a valid prompt.' });
    }

    if (provider === 'gemini') {
      let systemInstructionText = '';
      const contents = [];
      mergedMessages.forEach(m => {
        const role = (m.role || 'user').toString();
        if (role === 'system') { systemInstructionText += (systemInstructionText ? '\n' : '') + (m.content || ''); } 
        else if (role === 'assistant') { contents.push({ role: 'model', parts: [{ text: m.content || '' }] }); } 
        else { contents.push({ role: 'user', parts: [{ text: m.content || '' }] }); }
      });

      const geminiRequestBody = {
        contents,
        generation_config: { temperature: body.temperature ?? 0.2, top_k: body.top_k ?? undefined, top_p: body.top_p ?? 0.95 },
        safety_settings: body.safety_settings || promptService.DEFAULT_GEMINI_SAFETY_SETTINGS
      };
      if (systemInstructionText) geminiRequestBody.system_instruction = { parts: [{ text: systemInstructionText }] };

      if (body.stream) {
        console.log(`[${reqId}] Initializing Gemini stream...`);
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?key=${encodeURIComponent(apiKey)}&alt=sse`;
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
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
        const providerResp = await axios.post(url, geminiRequestBody, { headers: { 'Content-Type': 'application/json' }, timeout: 120000 });
        
        console.log(`[${reqId}] Gemini Non-Streaming RAW RESPONSE:`, JSON.stringify(providerResp.data, null, 2));

        const candidate = providerResp.data?.candidates?.[0];
        
        // --- THIS IS THE CRITICAL FIX ---
        // Check if the response was blocked by safety filters.
        if (candidate && !candidate.content) {
            const safetyInfo = {
                finishReason: candidate.finishReason,
                safetyRatings: candidate.safetyRatings,
                promptFeedback: providerResp.data.promptFeedback
            };
            const errorMessage = `Gemini response was blocked due to safety settings. Reason: ${safetyInfo.finishReason}.`;
            console.error(`[${reqId}] Gemini Safety Block:`, JSON.stringify(safetyInfo, null, 2));
            
            const finalErrorPayload = { error: { message: errorMessage, type: 'gemini_safety_block', ...safetyInfo } };
            console.log(`[${reqId}] TooruHub Final Error Response (Gemini Safety):`, JSON.stringify(finalErrorPayload, null, 2));
            return res.status(400).json(finalErrorPayload);
        }
        // --- END OF FIX ---

        const responsePayload = { 
            id: `chatcmpl-${reqId}`, 
            object: 'chat.completion', 
            created: Math.floor(Date.now() / 1000), 
            model, 
            choices: [{ 
                index: 0, 
                message: { 
                    role: 'assistant', 
                    content: candidate?.content?.parts?.[0]?.text ?? '' 
                }, 
                finish_reason: candidate?.finishReason || 'stop' 
            }], 
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } 
        };
        
        console.log(`[${reqId}] TooruHub Final Response (Gemini Non-Stream):`, JSON.stringify(responsePayload, null, 2));
        return res.json(responsePayload);
      }
    }

    if (provider === 'openrouter' || provider === 'openai' || provider === 'llm7') {
      const forwardBody = { ...body, messages: mergedMessages };
      
      let forwardUrl;
      if (provider === 'openrouter') forwardUrl = 'https://openrouter.ai/api/v1/chat/completions';
      else if (provider === 'openai') forwardUrl = 'https://api.openai.com/v1/chat/completions';
      else if (provider === 'llm7') forwardUrl = 'https://api.llm7.io/v1/chat/completions';
      
      if (forwardBody.stream) {
        console.log(`[${reqId}] Initializing ${provider} stream...`);
        const resp = await axios.post(forwardUrl, forwardBody, { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` }, responseType: 'stream', timeout: 120000 });
        res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Connection', 'keep-alive');
        
        resp.data.on('error', (pipeErr) => {
            console.error(`[${reqId}] Error during ${provider} stream pipe:`, pipeErr);
            res.end();
        });
        
        resp.data.pipe(res);
        return;
      }

      console.log(`[${reqId}] Initializing ${provider} non-streaming request...`);
      const providerResp = await axios.post(forwardUrl, forwardBody, { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` }, timeout: 120000 });
      
      console.log(`[${reqId}] ${provider} Non-Streaming RAW RESPONSE (Status: ${providerResp.status}):`, JSON.stringify(providerResp.data, null, 2));
      console.log(`[${reqId}] TooruHub Final Response (Forwarded from ${provider}):`, JSON.stringify(providerResp.data, null, 2));
      
      return res.status(providerResp.status).json(providerResp.data);
    }

    return res.status(400).json({ error: `Unsupported provider '${provider}'.` });

  } catch (err) {
    const errorData = err.response?.data;
    const errorStatus = err.response?.status;
    const errorText = JSON.stringify(errorData);

    if (keyToUse && provider !== 'llm7' && (errorStatus === 429 || (errorText && errorText.toLowerCase().includes('rate limit exceeded')))) {
        const reason = `[${errorStatus}] ${errorText}`;
        await keyService.deactivateKey(keyToUse.id, reason);
    }

    const logError = {
        message: err.message,
        isAxiosError: err.isAxiosError,
        request: err.config ? {
            method: err.config.method,
            url: err.config.url,
            headers: err.config.headers,
        } : undefined,
        response: err.response ? {
            status: err.response.status,
            headers: err.response.headers,
            data: err.response.data
        } : undefined
    };
    console.error(`[${reqId}] --- PROXY ERROR ---`, JSON.stringify(logError, null, 2));
    
    const finalErrorPayload = { error: 'TooruHub request failed', detail: err.response?.data ?? { message: err.message } };
    console.log(`[${reqId}] TooruHub Final Error Response:`, JSON.stringify(finalErrorPayload, null, 2));
    
    res.status(errorStatus || 500).json(finalErrorPayload);
  }
};