'use strict';

const APP_ALIASES = {
    whatsapp: 'whatsapp',
    'com.whatsapp': 'whatsapp',
    'com.whatsapp.w4b': 'whatsapp',
    instagram: 'instagram',
    'com.instagram.android': 'instagram',
    telegram: 'telegram',
    'org.telegram.messenger': 'telegram',
    snapchat: 'snapchat',
    'com.snapchat.android': 'snapchat',
    messenger: 'messenger',
    'com.facebook.orca': 'messenger',
    facebook: 'facebook',
    'com.facebook.katana': 'facebook',
    sms: 'sms',
    messages: 'sms',
};

function resolveChatAppKey(app) {
    if (!app) return 'other';
    const key = String(app).trim().toLowerCase();
    return APP_ALIASES[key] || key.replace(/[^a-z0-9._-]/g, '_').slice(0, 40) || 'other';
}

function notificationApp(pkg) {
    return resolveChatAppKey(pkg);
}

function isStrictChatRecordForApp(rec, appKey) {
    if (!rec || typeof rec !== 'object') return false;
    const text = String(rec.text || rec.message || '').trim();
    if (!text || text.length < 1) return false;
    if (isBadChatText(text)) return false;
    const conv = String(rec.conversation || rec.contact || '').trim();
    if (isBadChatConversation(conv)) return false;
    return true;
}

function isBadChatText(text) {
    if (!text) return true;
    const t = String(text).trim();
    if (t.length < 1) return true;
    // Filter common noise
    const bad = /^(typing|online|last seen|is typing|null|undefined)$/i;
    return bad.test(t);
}

function isBadChatConversation(conv) {
    if (!conv) return false;
    const c = String(conv).trim().toLowerCase();
    return c === 'null' || c === 'undefined' || c === 'unknown';
}

module.exports = {
    resolveChatAppKey,
    notificationApp,
    isStrictChatRecordForApp,
    isBadChatText,
    isBadChatConversation,
};
