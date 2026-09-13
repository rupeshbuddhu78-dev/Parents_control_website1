'use strict';

const crypto = require('crypto');

function generateEventKey(...parts) {
    const raw = parts.filter(Boolean).join('|');
    return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

function generateId(prefix) {
    return (prefix || '') + crypto.randomBytes(8).toString('hex');
}

function safeString(v, max) {
    if (v == null) return '';
    const s = String(v);
    return max ? s.slice(0, max) : s;
}

module.exports = { generateEventKey, generateId, safeString };
