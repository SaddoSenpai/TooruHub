// services/promptService.js
const pool = require('../config/db');

const DEFAULT_GEMINI_SAFETY_SETTINGS = [
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" }
];

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

    if (!userBlocks || userBlocks.length === 0) {
        return incomingBody.messages || [];
    }

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

module.exports = {
    DEFAULT_GEMINI_SAFETY_SETTINGS,
    buildFinalMessages
};