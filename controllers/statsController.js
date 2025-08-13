// controllers/statsController.js
const statsService = require('../services/statsService');

exports.getStats = async (req, res) => {
    try {
        const stats = await statsService.getStats();
        res.json(stats);
    } catch (err) {
        console.error('Failed to get server stats:', err);
        res.status(500).json({ error: 'Could not retrieve server stats.' });
    }
};