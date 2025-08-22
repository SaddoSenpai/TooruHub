// services/promptService.js
const pool = require('../config/db');
const cache = require('./cacheService');
const commandService = require('./commandService');

class UserInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserInputError';
  }
}

const DEFAULT_GEMINI_SAFETY_SETTINGS = [
  { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "OFF" },
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
];

async function parseJanitorInput(incomingMessages) {
  let characterName = 'Character';
  let characterInfo = '';
  let userInfo = '';
  let scenarioInfo = '';
  let summaryInfo = '';
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

  const summaryRegex = /<summary>([\s\S]*?)<\/summary>/;
  const summaryMatch = fullContent.match(summaryRegex);
  if (summaryMatch) {
    summaryInfo = summaryMatch[1].trim();
  }

  const chatHistory = (incomingMessages || [])
    .filter(m => {
        const content = m.content || '';
        return !content.includes("'s Persona>") && !content.includes("<UserPersona>") && !content.includes("<scenario>") && !content.includes("<summary>");
    })
    .map(m => {
        if (m.role === 'assistant' && m.content && m.content.includes('<w>')) {
            console.log('[History Cleaning] Found <w> tag in assistant message. Cleaning for next prompt.');
            return {
                ...m,
                content: m.content.split('<w>').pop().trim()
            };
        }
        return m;
    });

  return { characterName, characterInfo, userInfo, scenarioInfo, summaryInfo, chatHistory };
}

// MODIFIED: Function now accepts the provider to fetch the correct structure
async function buildFinalMessages(userId, incomingBody, user, provider) {
    if (incomingBody && incomingBody.bypass_prompt_structure) {
        return incomingBody.messages || [];
    }

    let structureToUse = [];

    if (user.use_predefined_structure) {
        console.log(`[Proxy] User ${userId || 'guest'} using Pre-defined Structure for provider: ${provider}.`);
        
        // MODIFIED: Cache key is now provider-specific
        const cacheKey = `global_structure:${provider}`;
        let globalBlocks = cache.get(cacheKey);

        if (!globalBlocks) {
            console.log(`[Cache] MISS for ${cacheKey}`);
            let result = await pool.query('SELECT * FROM global_prompt_blocks WHERE provider = $1 AND is_enabled = TRUE ORDER BY position', [provider]);
            
            // NEW: If no structure is found for the specific provider, fall back to the 'default' structure
            if (result.rows.length === 0 && provider !== 'default') {
                console.log(`[Proxy] No structure found for '${provider}', falling back to 'default' structure.`);
                const fallbackCacheKey = 'global_structure:default';
                globalBlocks = cache.get(fallbackCacheKey);
                if (!globalBlocks) {
                    console.log(`[Cache] MISS for ${fallbackCacheKey}`);
                    result = await pool.query('SELECT * FROM global_prompt_blocks WHERE provider = $1 AND is_enabled = TRUE ORDER BY position', ['default']);
                    globalBlocks = result.rows;
                    if (globalBlocks.length > 0) cache.set(fallbackCacheKey, globalBlocks, 600);
                } else {
                    console.log(`[Cache] HIT for ${fallbackCacheKey}`);
                }
            } else {
                globalBlocks = result.rows;
                if (globalBlocks.length > 0) cache.set(cacheKey, globalBlocks, 600);
            }
        } else {
            console.log(`[Cache] HIT for ${cacheKey}`);
        }
        
        const commandTags = commandService.parseCommandsFromMessages(incomingBody.messages);
        const commandDefinitions = await commandService.getCommandDefinitions(commandTags);

        const prefillCommands = commandDefinitions.filter(cmd => cmd.command_type === 'Prefill');
        if (prefillCommands.length > 1) {
            const conflictingTags = prefillCommands.map(cmd => `<${cmd.command_tag}>`).join(', ');
            const errorMessage = `Error. Only 1 Prefill type command is allowed. ${conflictingTags} are prefill type commands. Please choose only one of them.`;
            throw new UserInputError(errorMessage);
        }

        const hasPrefillCommand = prefillCommands.length > 0;

        const commandsByType = {
            'Jailbreak': [],
            'Additional Commands': [],
            'Prefill': []
        };

        if (commandDefinitions.length > 0) {
            console.log(`[Proxy] Found commands: ${commandTags.join(', ')}. Injecting blocks.`);
            commandDefinitions.forEach(cmd => {
                if (commandsByType[cmd.command_type]) {
                    commandsByType[cmd.command_type].push({
                        name: cmd.block_name,
                        role: cmd.block_role,
                        content: cmd.block_content,
                    });
                }
            });
        }

        const finalStructure = [];
        for (const block of globalBlocks) {
            if (block.block_type === 'Conditional Prefill') {
                if (!hasPrefillCommand) {
                    finalStructure.push(block);
                }
            } else if (block.block_type !== 'Standard') {
                const commandsToInject = commandsByType[block.block_type];
                if (commandsToInject && commandsToInject.length > 0) {
                    finalStructure.push(...commandsToInject);
                }
            } else {
                finalStructure.push(block);
            }
        }
        structureToUse = finalStructure;

    } else {
        // This path is only for registered users with pre-defined mode disabled.
        console.log(`[Proxy] User ${user.id} using Custom Structure.`);
        const activeSlot = user.active_config_slot || 1;
        const cacheKey = `blocks:enabled:${userId}:${activeSlot}`;
        let userBlocks = cache.get(cacheKey);
        if (userBlocks) {
            console.log(`[Cache] HIT for ${cacheKey}`);
        } else {
            console.log(`[Cache] MISS for ${cacheKey}`);
            const result = await pool.query('SELECT * FROM prompt_blocks WHERE user_id = $1 AND config_slot = $2 AND is_enabled = TRUE ORDER BY position', [userId, activeSlot]);
            userBlocks = result.rows;
            if (userBlocks.length > 0) {
                cache.set(cacheKey, userBlocks);
            }
        }
        structureToUse = userBlocks;
    }

    if (!structureToUse || structureToUse.length === 0) {
        return incomingBody.messages || [];
    }

    const fullConfigContent = structureToUse.map(b => b.content || '').join('');
    if (!fullConfigContent.includes('<<CHARACTER_INFO>>') || !fullConfigContent.includes('<<SCENARIO_INFO>>') || !fullConfigContent.includes('<<USER_INFO>>') || !fullConfigContent.includes('<<CHAT_HISTORY>>') || !fullConfigContent.includes('<<SUMMARY>>')) {
        throw new Error('The active prompt configuration is invalid. It must contain all five placeholders in its ENABLED blocks: <<CHARACTER_INFO>>, <<SCENARIO_INFO>>, <<USER_INFO>>, <<CHAT_HISTORY>>, and <<SUMMARY>>. Please contact the administrator or switch to a valid custom config.');
    }

    const { characterName, characterInfo, userInfo, scenarioInfo, summaryInfo, chatHistory } = await parseJanitorInput(incomingBody.messages);
    const finalMessages = [];

    for (const block of structureToUse) {
        let currentContent = block.content || '';
        const replacer = (text) => text
            .replace(/{{char}}/g, characterName)
            .replace(/<<CHARACTER_INFO>>/g, characterInfo)
            .replace(/<<SCENARIO_INFO>>/g, scenarioInfo)
            .replace(/<<USER_INFO>>/g, userInfo)
            .replace(/<<SUMMARY>>/g, summaryInfo);

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