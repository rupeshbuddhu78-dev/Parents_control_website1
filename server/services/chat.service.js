'use strict';

const { resolveChatAppKey } = require('../utils/validators');

function normalizeChatMessage(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const text = String(raw.text || raw.message || '').trim();
    if (!text) return null;
    const app = resolveChatAppKey(raw.app || raw.packageName || raw.package || 'other');
    const conversation = String(raw.conversation || raw.contact || raw.sender || 'unknown').trim();
    const timestamp = Number(raw.timestamp || raw.ts || Date.now()) || Date.now();
    const msgKey = raw.msgKey || `${app}|${conversation}|${timestamp}|${text.slice(0, 48)}`;
    return {
        app,
        conversation,
        contact: conversation,
        text,
        message: text,
        direction: raw.direction || raw.type || 'unknown',
        type: raw.msgType || 'TEXT',
        source: raw.source || 'accessibility',
        timestamp,
        clientTimestamp: Number(raw.clientTimestamp || 0) || 0,
        eventId: raw.eventId || '',
        msgKey,
    };
}

function groupByApp(list) {
    const map = {};
    for (const m of list) {
        if (!m) continue;
        const app = m.app || 'other';
        if (!map[app]) map[app] = [];
        map[app].push(m);
    }
    return map;
}

module.exports = { normalizeChatMessage, groupByApp };
