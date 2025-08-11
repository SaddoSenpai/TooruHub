// routes/config.js
const express = require('express');
const router = express.Router();
const configController = require('../controllers/configController');
const { requireAuth } = require('../middleware/auth');

// All routes here are automatically prefixed with /api by server.js

// Config Meta (names, active slot)
router.get('/configs/meta', requireAuth, configController.getConfigMeta);
router.put('/configs/meta', requireAuth, configController.updateConfigMeta);
router.get('/configs/active', requireAuth, configController.getActiveConfig);
router.put('/configs/active', requireAuth, configController.setActiveConfig);

// Import / Export
router.get('/configs/export', requireAuth, configController.exportConfig);
router.post('/configs/import', requireAuth, configController.importConfig);

// --- REFACTORED BLOCK MANAGEMENT ---
// Get all blocks for a slot
router.get('/config', requireAuth, configController.getBlocks);
// Atomically update all blocks for a slot
router.put('/config/slot/:slot', requireAuth, configController.updateSlotConfiguration);

module.exports = router;