'use strict';

const { resolveChatAppKey } = require('../utils/validators');

function normalizeChatMessage(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const text = String(raw.text || raw.message || '').trim();
    if (!text) return null;
    const app = resolveChatAppKey(raw.app || raw.packageName || raw.package || 'other');
    const conversation = String(raw.conversation || raw.contact || raw.contactName || raw.sender || 'unknown').trim();
    if (!conversation || conversation.toLowerCase() === 'unknown') return null;
    const timestamp = Number(raw.timestamp || raw.ts || Date.now()) || Date.now();
    const eventId = String(raw.eventId || '').trim();
    const msgKey = raw.msgKey || (eventId ? `${app}|${eventId}` : `${app}|${conversation}|${timestamp}|${text.slice(0, 48)}`);
    let direction = String(raw.direction || '').trim().toUpperCase();
    if (direction === 'OUTGOING' || direction === 'SENT') direction = 'OUT';
    if (direction !== 'OUT' && direction !== 'IN') direction = 'IN';
    return {
        app,
        packageName: raw.packageName || raw.package || '',
        conversation,
        contact: conversation,
        contactName: conversation,
        sender: raw.sender || (direction === 'OUT' ? 'You' : conversation),
        text,
        message: text,
        direction,
        type: raw.msgType || raw.messageType || 'TEXT',
        messageType: raw.messageType || raw.msgType || 'TEXT',
        source: raw.source || 'accessibility',
        timestamp,
        clientTimestamp: Number(raw.clientTimestamp || 0) || 0,
        eventId,
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
