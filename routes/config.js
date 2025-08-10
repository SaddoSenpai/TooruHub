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

// Block CRUD
router.get('/config', requireAuth, configController.getBlocks);
router.post('/config', requireAuth, configController.addBlock);
router.put('/config/:id', requireAuth, configController.updateBlock);
router.delete('/config/:id', requireAuth, configController.deleteBlock);

// Reordering
router.post('/config/reorder', requireAuth, configController.reorderBlocks);

module.exports = router;