// services/cryptoService.js
const crypto = require('crypto');

// Load environment variables
require('dotenv').config();

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY; // Must be 256 bits (32 characters)
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16; // For AES, this is always 16

if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length !== 44) { // 32 bytes = 44 Base64 characters
    throw new Error('FATAL: ENCRYPTION_KEY is not defined or is not a 32-byte base64 string.');
}

const key = Buffer.from(ENCRYPTION_KEY, 'base64');

function encrypt(text) {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();

    // We'll store the iv, authTag, and encrypted text together, separated by a colon.
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

function decrypt(text) {
    try {
        const parts = text.split(':');
        if (parts.length !== 3) {
            throw new Error('Invalid encrypted text format.');
        }

        const iv = Buffer.from(parts[0], 'hex');
        const authTag = Buffer.from(parts[1], 'hex');
        const encryptedText = parts[2];

        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(authTag);

        let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
        decrypted += decipher.final('utf8');

        return decrypted;
    } catch (error) {
        console.error('Decryption failed:', error);
        // Return a string indicating failure, as returning null might be ambiguous.
        return 'DECRYPTION_FAILED'; 
    }
}

module.exports = { encrypt, decrypt };