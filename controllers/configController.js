// controllers/configController.js
const pool = require('../config/db');

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
    res.json({ ok: true });
};

exports.exportConfig = async (req, res) => {
    const slot = parseInt(req.query.slot, 10);
    if (![1, 2, 3].includes(slot)) return res.status(400).json({ error: 'Invalid slot' });
    
    const userResult = await pool.query(`SELECT config_name_${slot} as name FROM users WHERE id = $1`, [req.user.id]);
    const configName = userResult.rows[0]?.name || `Config ${slot}`;
    
    const blocksResult = await pool.query('SELECT name, role, content FROM prompt_blocks WHERE user_id = $1 AND config_slot = $2 ORDER BY position', [req.user.id, slot]);
    const exportData = { configName, blocks: blocksResult.rows.map(b => ({ name: b.name, role: b.role, content: b.content })) };
    
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
        
        const fullImportedContent = importData.blocks.map(b => b.content || '').join('');
        if (!fullImportedContent.includes('<<PARSED_CHARACTER_INFO>>') || !fullImportedContent.includes('<<PARSED_USER_PERSONA>>') || !fullImportedContent.includes('<<PARSED_CHAT_HISTORY>>')) {
            throw new Error('Imported config is invalid. It must contain all three placeholders.');
        }
        
        await client.query('BEGIN');
        await client.query('DELETE FROM prompt_blocks WHERE user_id = $1 AND config_slot = $2', [req.user.id, slot]);
        await client.query(`UPDATE users SET config_name_${slot} = $1 WHERE id = $2`, [importData.configName, req.user.id]);
        for (let i = 0; i < importData.blocks.length; i++) {
            const block = importData.blocks[i];
            await client.query('INSERT INTO prompt_blocks (user_id, config_slot, name, role, content, position) VALUES ($1, $2, $3, $4, $5, $6)', [req.user.id, slot, block.name, block.role, block.content, i]);
        }
        await client.query('COMMIT');
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
  const result = await pool.query('SELECT id, name, role, content, position FROM prompt_blocks WHERE user_id = $1 AND config_slot = $2 ORDER BY position', [req.user.id, slot]);
  res.json({ blocks: result.rows });
};

exports.addBlock = async (req, res) => {
  const slot = parseInt(req.query.slot, 10) || 1;
  if (![1, 2, 3].includes(slot)) return res.status(400).json({ error: 'Invalid slot' });
  
  const { name, role, content } = req.body || {};
  if (!name || !role) return res.status(400).json({ error: 'name and role required' });
  
  const maxRow = await pool.query('SELECT MAX(position) as mx FROM prompt_blocks WHERE user_id = $1 AND config_slot = $2', [req.user.id, slot]);
  const nextPos = (maxRow.rows[0]?.mx ?? -1) + 1;
  
  await pool.query('INSERT INTO prompt_blocks (user_id, name, role, content, position, config_slot) VALUES ($1, $2, $3, $4, $5, $6)', [req.user.id, name, role, content || '', nextPos, slot]);
  
  const blocks = await pool.query('SELECT id, name, role, content, position FROM prompt_blocks WHERE user_id = $1 AND config_slot = $2 ORDER BY position', [req.user.id, slot]);
  res.json({ blocks: blocks.rows });
};

exports.updateBlock = async (req, res) => {
  const id = req.params.id;
  const { name, role, content } = req.body || {};
  
  const blockCheck = await pool.query('SELECT * FROM prompt_blocks WHERE id = $1 AND user_id = $2', [id, req.user.id]);
  const row = blockCheck.rows[0];
  if (!row) return res.status(404).json({ error: 'not found' });
  
  await pool.query('UPDATE prompt_blocks SET name = $1, role = $2, content = $3 WHERE id = $4', [name || row.name, role || row.role, content ?? row.content, id]);
  
  const blocks = await pool.query('SELECT id, name, role, content, position FROM prompt_blocks WHERE user_id = $1 AND config_slot = $2 ORDER BY position', [req.user.id, row.config_slot]);
  res.json({ blocks: blocks.rows });
};

exports.deleteBlock = async (req, res) => {
  const id = req.params.id;
  
  const blockCheck = await pool.query('SELECT * FROM prompt_blocks WHERE id = $1 AND user_id = $2', [id, req.user.id]);
  const row = blockCheck.rows[0];
  if (!row) return res.status(404).json({ error: 'not found' });
  
  await pool.query('DELETE FROM prompt_blocks WHERE id = $1', [id]);
  
  // Re-order remaining blocks
  const remaining = await pool.query('SELECT id FROM prompt_blocks WHERE user_id = $1 AND config_slot = $2 ORDER BY position', [req.user.id, row.config_slot]);
  for (let i = 0; i < remaining.rows.length; i++) {
    await pool.query('UPDATE prompt_blocks SET position = $1 WHERE id = $2', [i, remaining.rows[i].id]);
  }
  
  const blocks = await pool.query('SELECT id, name, role, content, position FROM prompt_blocks WHERE user_id = $1 AND config_slot = $2 ORDER BY position', [req.user.id, row.config_slot]);
  res.json({ blocks: blocks.rows });
};

exports.reorderBlocks = async (req, res) => {
  const slot = parseInt(req.query.slot, 10) || 1;
  if (![1, 2, 3].includes(slot)) return res.status(400).json({ error: 'Invalid slot' });
  
  const { order } = req.body || {};
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order array required' });
  
  for (let i = 0; i < order.length; i++) {
    const id = order[i];
    await pool.query('UPDATE prompt_blocks SET position = $1 WHERE id = $2 AND user_id = $3 AND config_slot = $4', [i, id, req.user.id, slot]);
  }
  
  const blocks = await pool.query('SELECT id, name, role, content, position FROM prompt_blocks WHERE user_id = $1 AND config_slot = $2 ORDER BY position', [req.user.id, slot]);
  res.json({ blocks: blocks.rows });
};