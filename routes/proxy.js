// routes/proxy.js
const express = require('express');
const router = express.Router();
const proxyController = require('../controllers/proxyController');

// REMOVED: The 'requireAuth' middleware is no longer needed here.
// The new 'flexibleAuth' middleware is applied in server.js, which is the correct place for it.
// This allows the controller to handle both registered users and guest users.

// This route is automatically prefixed with /v1 or /llm7/v1 by server.js
router.post('/chat/completions', proxyController.handleProxyRequest);

module.exports = router;