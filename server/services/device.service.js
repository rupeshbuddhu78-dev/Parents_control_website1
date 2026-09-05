'use strict';

/**
 * In-memory device registry (status + pending commands).
 * Survives within a single Node process; multi-instance deploys need Redis.
 */

const devices = new Map(); // deviceId -> device object
const commands = new Map(); // deviceId -> command string

function normalizeId(id) {
    return String(id || '').trim().toUpperCase();
}

function getDevice(id) {
    id = normalizeId(id);
    if (!id) return null;
    return devices.get(id) || null;
}

function setDevice(id, patch) {
    id = normalizeId(id);
    if (!id) return null;
    const prev = devices.get(id) || { deviceId: id, lastSeen: 0, isOnline: false };
    const next = { ...prev, ...patch, deviceId: id };
    if (typeof next.lastSeen === 'number' && next.lastSeen > 0) {
        next.isOnline = (Date.now() - next.lastSeen) < 90000;
    }
    devices.set(id, next);
    return next;
}

function getDeviceStatus(id) {
    id = normalizeId(id);
    const d = devices.get(id);
    if (!d) {
        return {
            id: id,
            deviceId: id,
            isOnline: false,
            lastSeen: 0,
            exists: false,
            battery: 0,
            charging: false,
            model: null,
            version: '--',
        };
    }
    const isOnline = d.lastSeen && (Date.now() - d.lastSeen) < 120000;
    return {
        id: id,
        deviceId: id,
        isOnline: !!isOnline,
        lastSeen: d.lastSeen || 0,
        battery: d.battery != null ? d.battery : 0,
        charging: !!d.charging,
        model: d.model || 'Unknown',
        version: d.version || d.androidVersion || '--',
        androidVersion: d.androidVersion || d.version || '--',
        network: d.network || null,
        lat: d.lat || 0,
        lon: d.lon || 0,
        exists: true,
        ...d,
        id: id,
        deviceId: id,
        isOnline: !!isOnline,
    };
}

function getAllDevices() {
    const out = [];
    for (const [id, d] of devices.entries()) {
        out.push(getDeviceStatus(id));
    }
    return out;
}

function setCommand(id, command) {
    id = normalizeId(id);
    if (!id) return;
    commands.set(id, command);
}

function consumeCommand(id) {
    id = normalizeId(id);
    if (!commands.has(id)) return null;
    const cmd = commands.get(id);
    commands.delete(id);
    return cmd;
}

module.exports = {
    getDevice,
    setDevice,
    getDeviceStatus,
    getAllDevices,
    setCommand,
    consumeCommand,
};
