// routes/keys.js
const express = require('express');
const router = express.Router();
const keyController = require('../controllers/keyController');
const { requireAuth } = require('../middleware/auth');

router.post('/add-keys', requireAuth, keyController.addKey);
router.get('/keys', requireAuth, keyController.getKeys);
router.delete('/keys/:id', requireAuth, keyController.deleteKey);

router.post('/api/keys/:id/reactivate', requireAuth, keyController.reactivateKey);
router.post('/api/keys/:id/deactivate', requireAuth, keyController.deactivateKey);
router.post('/api/keys/:id/test', requireAuth, keyController.testKey);

module.exports = router;