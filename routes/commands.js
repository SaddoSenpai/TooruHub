// routes/commands.js
const express = require('express');
const router = express.Router();
const commandController = require('../controllers/commandController');

// This is a public route, no authentication is required.
// It's prefixed with /api in server.js, so the full path is /api/commands/public
router.get('/commands/public', commandController.getPublicCommands);

module.exports = router;