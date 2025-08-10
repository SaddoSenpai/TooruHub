// routes/proxy.js
const express = require('express');
const router = express.Router();
const proxyController = require('../controllers/proxyController');
const { requireAuth } = require('../middleware/auth');

// This route is automatically prefixed with /v1 by server.js
router.post('/chat/completions', requireAuth, proxyController.handleProxyRequest);

module.exports = router;