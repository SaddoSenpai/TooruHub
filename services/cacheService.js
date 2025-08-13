// services/cacheService.js
const NodeCache = require('node-cache');

// stdTTL: default time-to-live in seconds for every new entry.
// checkperiod: how often the cache checks for expired keys.
const cache = new NodeCache({ stdTTL: 600, checkperiod: 120 });

console.log('In-memory cache service initialized.');

module.exports = cache;