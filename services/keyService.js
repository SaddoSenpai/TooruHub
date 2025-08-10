// services/keyService.js
const pool = require('../config/db');

// In-Memory state for round-robin key rotation
const keyRotationState = {};

async function getRotatingKey(userId, provider) {
    const res = await pool.query('SELECT * FROM api_keys WHERE user_id = $1 AND provider = $2 AND is_active = TRUE ORDER BY id', [userId, provider]);
    const activeKeys = res.rows;
    if (activeKeys.length === 0) return null;

    if (!keyRotationState[userId]) keyRotationState[userId] = {};
    if (keyRotationState[userId][provider] === undefined) keyRotationState[userId][provider] = 0;

    const currentIndex = keyRotationState[userId][provider];
    const selectedKey = activeKeys[currentIndex];
    
    // Move to the next key for the next request
    keyRotationState[userId][provider] = (currentIndex + 1) % activeKeys.length;
    
    return selectedKey;
}

async function deactivateKey(keyId, reason) {
    console.log(`Deactivating key ${keyId} due to: ${reason}`);
    await pool.query('UPDATE api_keys SET is_active = FALSE, deactivated_at = NOW(), deactivation_reason = $1 WHERE id = $2', [reason, keyId]);
}

async function reactivateKeys() {
    console.log('Running key reactivation check...');
    try {
        const { rows } = await pool.query("SELECT id, provider, deactivated_at, deactivation_reason FROM api_keys WHERE is_active = FALSE AND deactivated_at IS NOT NULL");
        
        if (rows.length === 0) {
            console.log('-> No inactive keys found to check.');
            return;
        }

        const now = new Date();
        const nowUTC = now.toISOString().split('T')[0];
        const nowPST = new Date(now.getTime() - 8 * 60 * 60 * 1000).toISOString().split('T')[0];

        const keysToReactivate = [];
        for (const key of rows) {
            if (key.deactivation_reason && key.deactivation_reason.startsWith('[Manual]')) {
                continue; // Skip manually deactivated keys
            }

            const deactivatedDateUTC = new Date(key.deactivated_at).toISOString().split('T')[0];
            const deactivatedDatePST = new Date(new Date(key.deactivated_at).getTime() - 8 * 60 * 60 * 1000).toISOString().split('T')[0];

            if (key.provider === 'gemini' && nowPST > deactivatedDatePST) {
                keysToReactivate.push(key.id);
            } else if (key.provider === 'openrouter' && nowUTC > deactivatedDateUTC) {
                keysToReactivate.push(key.id);
            }
        }

        if (keysToReactivate.length > 0) {
            console.log(`-> Reactivating keys: ${keysToReactivate.join(', ')}`);
            await pool.query(
                'UPDATE api_keys SET is_active = TRUE, deactivated_at = NULL, deactivation_reason = NULL WHERE id = ANY($1::int[])',
                [keysToReactivate]
            );
        } else {
            console.log('-> Checked inactive keys, but none were eligible for automatic reactivation.');
        }
    } catch (err) {
        console.error('Error during key reactivation job:', err);
    }
}

function startReactivationJob() {
    console.log('Performing initial key reactivation check on startup...');
    reactivateKeys();
    setInterval(reactivateKeys, 60 * 60 * 1000); // Run every hour
}

module.exports = {
    getRotatingKey,
    deactivateKey,
    startReactivationJob
};