// controllers/configController.js
const pool = require('../config/db');
const cache = require('../services/cacheService');

exports.getConfigMeta = async (req, res) => {
    const result = await pool.query('SELECT config_name_1, config_name_2, config_name_3, active_config_slot FROM users WHERE id = $1', [req.user.id]);
    res.json(result.rows[0]);
};

exports.updateConfigMeta = async (req, res) => {
    const { names } = req.body;
    if (!Array.isArray(names) || names.length !== 3) { return res.status(400).json({ error: 'Invalid names array' }); }
    await pool.query('UPDATE users SET config_name_1 = $1, config_name_2 = $2, config_name_3 = $3 WHERE id = $4', [names[0], names[1], names[2], req.user.id]);
    res.json({ ok: true });
};

exports.getActiveConfig = async (req, res) => {
    const result = await pool.query('SELECT active_config_slot FROM users WHERE id = $1', [req.user.id]);
    res.json(result.rows[0]);
};

exports.setActiveConfig = async (req, res) => {
    const { slot } = req.body;
    if (![1, 2, 3].includes(slot)) { return res.status(400).json({ error: 'Invalid slot number' }); }
    await pool.query('UPDATE users SET active_config_slot = $1 WHERE id = $2', [slot, req.user.id]);
    const userCacheKey = `user:${req.user.proxy_token}`;
    cache.del(userCacheKey);
    console.log(`[Cache] DELETED ${userCacheKey} due to active slot change.`);
    res.json({ ok: true });
};

exports.exportConfig = async (req, res) => {
    const slot = parseInt(req.query.slot, 10);
    if (![1, 2, 3].includes(slot)) return res.status(400).json({ error: 'Invalid slot' });
    
    const userResult = await pool.query(`SELECT config_name_${slot} as name FROM users WHERE id = $1`, [req.user.id]);
    const configName = userResult.rows[0]?.name || `Config ${slot}`;
    
    const blocksResult = await pool.query('SELECT name, role, content, is_enabled FROM prompt_blocks WHERE user_id = $1 AND config_slot = $2 ORDER BY position', [req.user.id, slot]);
    const exportData = { configName, blocks: blocksResult.rows.map(b => ({ name: b.name, role: b.role, content: b.content, is_enabled: b.is_enabled })) };
    
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${configName.replace(/ /g, '_')}.json"`);
    res.send(JSON.stringify(exportData, null, 2));
};

exports.importConfig = async (req, res) => {
    const slot = parseInt(req.query.slot, 10);
    if (![1, 2, 3].includes(slot)) return res.status(400).json({ error: 'Invalid slot' });
    if (!req.files || Object.keys(req.files).length === 0) { return res.status(400).json({ error: 'No file uploaded.' }); }
    
    const client = await pool.connect();
    try {
        const file = req.files.configFile;
        const importData = JSON.parse(file.data.toString('utf8'));
        if (!importData.configName || !Array.isArray(importData.blocks)) { throw new Error('Invalid JSON format'); }
        
        const enabledBlocks = importData.blocks.filter(b => b.is_enabled !== false);
        const fullImportedContent = enabledBlocks.map(b => b.content || '').join('');
        if (!fullImportedContent.includes('<<CHARACTER_INFO>>') || !fullImportedContent.includes('<<SCENARIO_INFO>>') || !fullImportedContent.includes('<<USER_INFO>>') || !fullImportedContent.includes('<<CHAT_HISTORY>>')) {
            throw new Error('Imported config is invalid. It must contain all four placeholders in its enabled blocks.');
        }
        
        await client.query('BEGIN');
        await client.query('DELETE FROM prompt_blocks WHERE user_id = $1 AND config_slot = $2', [req.user.id, slot]);
        await client.query(`UPDATE users SET config_name_${slot} = $1 WHERE id = $2`, [importData.configName, req.user.id]);
        for (let i = 0; i < importData.blocks.length; i++) {
            const block = importData.blocks[i];
            const isEnabled = block.is_enabled !== false;
            await client.query('INSERT INTO prompt_blocks (user_id, config_slot, name, role, content, position, is_enabled) VALUES ($1, $2, $3, $4, $5, $6, $7)', [req.user.id, slot, block.name, block.role, block.content, i, isEnabled]);
        }
        await client.query('COMMIT');
        
        const cacheKey = `blocks:enabled:${req.user.id}:${slot}`;
        cache.del(cacheKey);
        console.log(`[Cache] DELETED ${cacheKey} due to config import.`);
        res.json({ ok: true, newName: importData.configName });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Import error:", err);
        res.status(500).json({ error: 'Failed to import config.', detail: err.message });
    } finally {
        client.release();
    }
};

exports.getBlocks = async (req, res) => {
  const slot = parseInt(req.query.slot, 10) || 1;
  if (![1, 2, 3].includes(slot)) return res.status(400).json({ error: 'Invalid slot' });
  const result = await pool.query('SELECT id, name, role, content, position, is_enabled FROM prompt_blocks WHERE user_id = $1 AND config_slot = $2 ORDER BY position', [req.user.id, slot]);
  res.json({ blocks: result.rows });
};

exports.updateSlotConfiguration = async (req, res) => {
    const slot = parseInt(req.params.slot, 10);
    if (![1, 2, 3].includes(slot)) return res.status(400).json({ error: 'Invalid slot' });

    const { blocks } = req.body;
    if (!Array.isArray(blocks)) return res.status(400).json({ error: 'blocks array is required' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM prompt_blocks WHERE user_id = $1 AND config_slot = $2', [req.user.id, slot]);

        for (let i = 0; i < blocks.length; i++) {
            const block = blocks[i];
            await client.query(
                'INSERT INTO prompt_blocks (user_id, config_slot, name, role, content, position, is_enabled) VALUES ($1, $2, $3, $4, $5, $6, $7)',
                [req.user.id, slot, block.name, block.role, block.content, i, block.is_enabled]
            );
        }

        await client.query('COMMIT');
        
        const cacheKey = `blocks:enabled:${req.user.id}:${slot}`;
        cache.del(cacheKey);
        console.log(`[Cache] DELETED ${cacheKey} due to config update.`);
        
        const result = await pool.query('SELECT id, name, role, content, position, is_enabled FROM prompt_blocks WHERE user_id = $1 AND config_slot = $2 ORDER BY position', [req.user.id, slot]);
        res.json({ blocks: result.rows });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Config slot update error:", err);
        res.status(500).json({ error: 'Failed to save configuration.', detail: err.message });
    } finally {
        client.release();
    }
};