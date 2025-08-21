// routes/tooru.js
const express = require('express');
const router = express.Router();
const tooruController = require('../controllers/tooruController');
const { requireAuth } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/admin');

// All routes in this file are protected and require admin privileges.
// The prefix /api/tooru is added in server.js
router.use(requireAuth, requireAdmin);

// Global Prompt Structure
router.get('/global-blocks', tooruController.getGlobalBlocks);
router.put('/global-blocks', tooruController.updateGlobalBlocks);
router.get('/global-blocks/export', tooruController.exportGlobalStructure); // <-- NEW
router.post('/global-blocks/import', tooruController.importGlobalStructure); // <-- NEW

// Commands
router.get('/commands', tooruController.getCommands);
router.post('/commands', tooruController.createCommand);
router.put('/commands/:id', tooruController.updateCommand);
router.delete('/commands/:id', tooruController.deleteCommand);

module.exports = router;