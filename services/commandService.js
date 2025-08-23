// services/commandService.js
const pool = require('../config/db');
const cache = require('./cacheService');

class CommandService {
    /**
     * Scans messages for <COMMAND> tags and returns a unique list of tags found.
     * @param {Array<Object>} messages - The incoming messages from the client.
     * @returns {Array<string>} - An array of command tags like ['JAILBREAKON', 'SHOWTHINKING'].
     */
    parseCommandsFromMessages(messages) {
        if (!messages || messages.length === 0) {
            return [];
        }
        const fullText = messages.map(m => m.content || '').join(' ');
        // MODIFIED: Added the '=' symbol to the allowed character set in the regex.
        const commandRegex = /<([A-Z0-9_=]+)>/g;
        const matches = [...fullText.matchAll(commandRegex)];
        // Return unique, uppercase command tags found
        return [...new Set(matches.map(match => match[1].toUpperCase()))];
    }

    /**
     * Fetches the definitions for a list of command tags from the database, using a cache.
     * @param {Array<string>} commandTags - The tags to look up.
     * @returns {Promise<Array<Object>>} - A promise that resolves to the command definitions.
     */
    async getCommandDefinitions(commandTags) {
        if (commandTags.length === 0) return [];

        // Caching is extremely effective here to avoid DB hits for common commands
        const cacheKey = `commands:defs`;
        let allCommands = cache.get(cacheKey);

        if (!allCommands) {
            console.log(`[Cache] MISS for all commands. Fetching from DB.`);
            const result = await pool.query('SELECT * FROM commands');
            allCommands = result.rows;
            // Cache all commands for 10 minutes
            cache.set(cacheKey, allCommands, 600);
        } else {
            console.log(`[Cache] HIT for all commands.`);
        }
        
        const upperCaseTags = commandTags.map(tag => tag.toUpperCase());
        
        // Filter the cached/fetched commands to find the ones we need
        return allCommands.filter(cmd => upperCaseTags.includes(cmd.command_tag.toUpperCase()));
    }
}

module.exports = new CommandService();