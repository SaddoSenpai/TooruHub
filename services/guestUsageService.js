// services/guestUsageService.js
const pool = require('../config/db');
const { encrypt } = require('./cryptoService');
const crypto = require('crypto');

function hashKey(apiKey) {
    return crypto.createHash('sha256').update(apiKey).digest('hex');
}

/**
 * Logs the usage of a guest API key.
 * If the key has been seen before (based on its hash), it updates the timestamp.
 * Otherwise, it inserts a new record.
 * @param {string} apiKey - The raw guest API key.
 * @param {string} provider - The provider the key was used for.
 * @param {string} ipAddress - The IP address of the user.
 */
async function logGuestKeyUsage(apiKey, provider, ipAddress) {
    const encryptedKey = encrypt(apiKey);
    const hashedKey = hashKey(apiKey);

    try {
        // This "UPSERT" command efficiently handles both new and returning keys.
        await pool.query(
            `INSERT INTO guest_key_usage (api_key_encrypted, api_key_hash, provider, ip_address, last_used_at)
             VALUES ($1, $2, $3, $4, NOW())
             ON CONFLICT (api_key_hash) 
             DO UPDATE SET 
                last_used_at = NOW(),
                provider = EXCLUDED.provider,
                ip_address = EXCLUDED.ip_address;`,
            [encryptedKey, hashedKey, provider, ipAddress]
        );
        console.log(`[Guest Logging] Successfully logged usage for key ending in ...${apiKey.slice(-4)}`);
    } catch (err) {
        console.error('[Guest Logging] Failed to log guest key usage:', err);
        // This is a non-critical operation, so we don't throw the error to stop the request.
    }
}

module.exports = { logGuestKeyUsage };