'use strict';

const ActivityEvent = require('../models/ActivityEvent');
const crypto = require('crypto');

// In-memory typing / live activity state per device
const typingState = new Map();
const liveTimestamps = new Map();
const timers = new Map();

function getLatestLiveTimestamp(deviceId) {
    return liveTimestamps.get(String(deviceId).toUpperCase()) || 0;
}

function setLatestLiveTimestamp(deviceId, ts) {
    liveTimestamps.set(String(deviceId).toUpperCase(), Number(ts) || Date.now());
}

function getTypingState(deviceId) {
    return typingState.get(String(deviceId).toUpperCase()) || null;
}

function setTypingState(deviceId, state) {
    typingState.set(String(deviceId).toUpperCase(), state);
}

function discardTypingState(deviceId) {
    const id = String(deviceId).toUpperCase();
    typingState.delete(id);
    if (timers.has(id)) {
        clearTimeout(timers.get(id));
        timers.delete(id);
    }
}

function sameComposer(a, b) {
    if (!a || !b) return false;
    return String(a.packageName || a.app || '') === String(b.packageName || b.app || '')
        && String(a.actorName || a.contact || '') === String(b.actorName || b.contact || '');
}

function parseLiveActivityText(text) {
    if (!text) return { text: '', structured: {} };
    const t = String(text);
    return {
        text: t,
        structured: {
            packageName: '',
            actorName: '',
            action: 'activity',
            message: t,
        },
    };
}

function scheduleFinalize(deviceId, delayMs) {
    const id = String(deviceId).toUpperCase();
    if (timers.has(id)) clearTimeout(timers.get(id));
    const t = setTimeout(async () => {
        timers.delete(id);
        const state = typingState.get(id);
        if (state && !state.saved) {
            try {
                await commitFinalActivity(id, state, global.io);
            } catch (e) { /* ignore */ }
            discardTypingState(id);
        }
    }, delayMs || 2500);
    timers.set(id, t);
}

async function commitFinalActivity(deviceId, state, io) {
    const id = String(deviceId).toUpperCase();
    if (!state) return;
    const structured = state.structured || {};
    const eventId = crypto.createHash('sha256')
        .update(`${id}|${state.firstSeen}|${state.text || ''}`)
        .digest('hex')
        .slice(0, 24);

    try {
        await ActivityEvent.updateOne(
            { deviceId: id, eventId },
            {
                $setOnInsert: {
                    deviceId: id,
                    application: structured.application || structured.app || 'Other',
                    packageName: structured.packageName || '',
                    actorName: structured.actorName || '',
                    action: structured.action || 'activity',
                    message: state.text || structured.message || '',
                    text: state.text || '',
                    timestamp: new Date(state.lastSeen || Date.now()),
                    eventId,
                },
            },
            { upsert: true }
        );
        if (io) {
            try {
                io.to(id).emit('activity_update', {
                    device_id: id,
                    text: state.text,
                    timestamp: state.lastSeen || Date.now(),
                });
            } catch (e) { /* ignore */ }
        }
    } catch (e) {
        console.error('[activity] commit failed', e.message);
    }
}

module.exports = {
    getLatestLiveTimestamp,
    setLatestLiveTimestamp,
    getTypingState,
    setTypingState,
    discardTypingState,
    sameComposer,
    parseLiveActivityText,
    scheduleFinalize,
    commitFinalActivity,
};
