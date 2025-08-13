// routes/stats.js
const express = require('express');
const router = express.Router();
const statsController = require('../controllers/statsController');
const { requireAuth } = require('../middleware/auth');

// All routes here are automatically prefixed with /api by server.js
router.get('/stats', requireAuth, statsController.getStats);

module.exports = router;