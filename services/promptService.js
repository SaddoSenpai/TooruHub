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
  let userInfo = ''; // Renamed from userPersona
  let scenarioInfo = ''; // Renamed from scenario
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
    userInfo = userMatch[1].trim();
  }

  const scenarioRegex = /<scenario>([\s\S]*?)<\/scenario>/;
  const scenarioMatch = fullContent.match(scenarioRegex);
  if (scenarioMatch) {
    scenarioInfo = scenarioMatch[1].trim();
  }

  chatHistory = (incomingMessages || []).filter(m => {
    const content = m.content || '';
    return !content.includes("'s Persona>") && !content.includes("<UserPersona>") && !content.includes("<scenario>");
  });

  return { characterName, characterInfo, userInfo, scenarioInfo, chatHistory };
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
    if (!fullConfigContent.includes('<<CHARACTER_INFO>>') || !fullConfigContent.includes('<<SCENARIO_INFO>>') || !fullConfigContent.includes('<<USER_INFO>>') || !fullConfigContent.includes('<<CHAT_HISTORY>>')) {
        throw new Error('Your active proxy configuration is invalid. It must contain all four placeholders. Please edit it in /config.');
    }

    const { characterName, characterInfo, userInfo, scenarioInfo, chatHistory } = await parseJanitorInput(incomingBody.messages);
    const finalMessages = [];

    for (const block of userBlocks) {
        let currentContent = block.content || '';
        // Define a replacer function for clarity
        const replacer = (text) => text
            .replace(/{{char}}/g, characterName)
            .replace(/<<CHARACTER_INFO>>/g, characterInfo)
            .replace(/<<SCENARIO_INFO>>/g, scenarioInfo)
            .replace(/<<USER_INFO>>/g, userInfo);

        if (currentContent.includes('<<CHAT_HISTORY>>')) {
            const parts = currentContent.split('<<CHAT_HISTORY>>');
            const beforeText = parts[0];
            const afterText = parts[1];
            if (beforeText.trim()) {
                finalMessages.push({ role: block.role, content: replacer(beforeText) });
            }
            finalMessages.push(...chatHistory);
            if (afterText.trim()) {
                finalMessages.push({ role: block.role, content: replacer(afterText) });
            }
        } else {
            currentContent = replacer(currentContent);
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