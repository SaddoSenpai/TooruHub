// controllers/tooruController.js
const pool = require('../config/db');
const cache = require('../services/cacheService');

// --- Global Structure Management ---

exports.getGlobalBlocks = async (req, res) => {
    const result = await pool.query('SELECT * FROM global_prompt_blocks ORDER BY position');
    res.json({ blocks: result.rows });
};

exports.updateGlobalBlocks = async (req, res) => {
    const { blocks } = req.body;
    if (!Array.isArray(blocks)) return res.status(400).json({ error: 'blocks array is required' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM global_prompt_blocks');

        for (let i = 0; i < blocks.length; i++) {
            const block = blocks[i];
            await client.query(
                'INSERT INTO global_prompt_blocks (name, role, content, position, is_enabled, block_type) VALUES ($1, $2, $3, $4, $5, $6)',
                [block.name, block.role, block.content, i, block.is_enabled, block.block_type]
            );
        }
        await client.query('COMMIT');
        
        cache.del('global_structure');
        console.log('[Cache] DELETED global_structure due to admin update.');
        
        const result = await pool.query('SELECT * FROM global_prompt_blocks ORDER BY position');
        res.json({ blocks: result.rows });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Global blocks update error:", err);
        res.status(500).json({ error: 'Failed to save global configuration.', detail: err.message });
    } finally {
        client.release();
    }
};

// --- NEW: Import/Export for Global Structure ---
exports.exportGlobalStructure = async (req, res) => {
    const blocksResult = await pool.query('SELECT name, role, content, is_enabled, block_type FROM global_prompt_blocks ORDER BY position');
    const exportData = { configName: "TooruHub Global Structure", blocks: blocksResult.rows };
    
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="tooruhub_global_structure.json"`);
    res.send(JSON.stringify(exportData, null, 2));
};

exports.importGlobalStructure = async (req, res) => {
    if (!req.files || Object.keys(req.files).length === 0) {
        return res.status(400).json({ error: 'No file uploaded.' });
    }
    
    const client = await pool.connect();
    try {
        const file = req.files.configFile;
        const importData = JSON.parse(file.data.toString('utf8'));
        if (!importData.configName || !Array.isArray(importData.blocks)) {
            throw new Error('Invalid JSON format for import.');
        }
        
        await client.query('BEGIN');
        await client.query('DELETE FROM global_prompt_blocks');
        for (let i = 0; i < importData.blocks.length; i++) {
            const block = importData.blocks[i];
            await client.query(
                'INSERT INTO global_prompt_blocks (name, role, content, position, is_enabled, block_type) VALUES ($1, $2, $3, $4, $5, $6)',
                [block.name, block.role, block.content, i, block.is_enabled, block.block_type || 'Standard']
            );
        }
        await client.query('COMMIT');
        
        cache.del('global_structure');
        console.log(`[Cache] DELETED global_structure due to config import.`);
        res.json({ ok: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Global structure import error:", err);
        res.status(500).json({ error: 'Failed to import global structure.', detail: err.message });
    } finally {
        client.release();
    }
};


// --- Command Management ---

exports.getCommands = async (req, res) => {
    const result = await pool.query('SELECT * FROM commands ORDER BY command_tag');
    res.json({ commands: result.rows });
};

exports.createCommand = async (req, res) => {
    const { command_tag, block_name, block_role, block_content, command_type } = req.body;
    if (!command_tag || !block_name || !block_role || !command_type) {
        return res.status(400).json({ error: 'Missing required fields.' });
    }
    try {
        const result = await pool.query(
            'INSERT INTO commands (command_tag, block_name, block_role, block_content, command_type) VALUES ($1, $2, $3, $4, $5) RETURNING *',
            [command_tag.toUpperCase(), block_name, block_role, block_content, command_type]
        );
        cache.del('commands:defs');
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Failed to create command.', detail: err.message });
    }
};

exports.updateCommand = async (req, res) => {
    const { id } = req.params;
    const { command_tag, block_name, block_role, block_content, command_type } = req.body;
    try {
        const result = await pool.query(
            'UPDATE commands SET command_tag = $1, block_name = $2, block_role = $3, block_content = $4, command_type = $5, updated_at = NOW() WHERE id = $6 RETURNING *',
            [command_tag.toUpperCase(), block_name, block_role, block_content, command_type, id]
        );
        if (result.rowCount === 0) return res.status(404).json({ error: 'Command not found.' });
        cache.del('commands:defs');
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Failed to update command.', detail: err.message });
    }
};

exports.deleteCommand = async (req, res) => {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM commands WHERE id = $1', [id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Command not found.' });
    cache.del('commands:defs');
    res.status(204).send();
};