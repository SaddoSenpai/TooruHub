// controllers/commandController.js
const pool = require('../config/db');

/**
 * Fetches a list of commands for public display.
 * Only includes the tag and name for security and simplicity.
 */
exports.getPublicCommands = async (req, res) => {
    try {
        // We only select the fields that are safe for public viewing.
        const result = await pool.query('SELECT command_tag, block_name FROM commands ORDER BY command_tag');
        res.json({ commands: result.rows });
    } catch (err) {
        console.error('Failed to get public commands:', err);
        res.status(500).json({ error: 'Could not retrieve command list.' });
    }
};