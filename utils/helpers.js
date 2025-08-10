// utils/helpers.js
const crypto = require('crypto');

function genToken() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = { genToken };