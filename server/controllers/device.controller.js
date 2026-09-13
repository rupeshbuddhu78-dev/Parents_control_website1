'use strict';

const deviceService = require('../services/device.service');
const dbService = require('../services/database.service');
const DeviceMeta = require('../models/DeviceMeta');

// GET /api/admin/all-devices
function getAllDevices(req, res) {
    res.json(deviceService.getAllDevices());
}

// GET /api/device-status/:id
async function getDeviceStatus(req, res) {
    try {
        const id = req.params.id.toUpperCase().trim();
        let status = deviceService.getDeviceStatus(id);

        // Always hydrate from DB when memory empty OR model/version missing (new device lag fix)
        const needsHydrate = !status.exists
            || !status.model
            || status.model === 'Unknown'
            || status.version === '--'
            || status.battery == null;
        if (needsHydrate) {
            try {
                let meta = await DeviceMeta.findOne({ deviceId: id }).lean();
                if (!meta) {
                    // case-insensitive fallback
                    meta = await DeviceMeta.findOne({
                        $expr: { $eq: [{ $toUpper: { $ifNull: ['$deviceId', ''] } }, id] }
                    }).lean();
                }
                if (meta) {
                    const lastSeen = meta.lastSeen || (meta.updatedAt ? new Date(meta.updatedAt).getTime() : 0);
                    const isOnline = lastSeen && (Date.now() - lastSeen) < 35000;
                    deviceService.setDevice(id, {
                        model: meta.model || status.model,
                        manufacturer: meta.manufacturer,
                        battery: meta.battery != null ? meta.battery : status.battery,
                        charging: meta.charging,
                        androidVersion: meta.androidVersion || meta.version,
                        version: meta.androidVersion || meta.version || status.version,
                        sdkVersion: meta.sdkVersion,
                        appVersion: meta.appVersion,
                        network: meta.network,
                        lastSeen: lastSeen || status.lastSeen || 0,
                        lat: meta.lastLocation && (meta.lastLocation.latitude || meta.lastLocation.lat),
                        lon: meta.lastLocation && (meta.lastLocation.longitude || meta.lastLocation.lon),
                    });
                    status = deviceService.getDeviceStatus(id);
                    if (!status.isOnline && isOnline) status.isOnline = true;
                }
            } catch (e) {
                console.warn('getDeviceStatus hydrate', e.message);
            }
        }

// Online from lastSeen only. Room size is NOT used — parent tab joins same room
        // and was forcing Connected after app delete / network off.
        try {
            const io = global.io;
            if (io) {
                const room = io.sockets.adapter.rooms.get(id);
                if (room && room.size > 0) {
                    let childPresent = false;
                    for (const sid of room) {
                        const s = io.sockets.sockets.get(sid);
                        if (s && s.data && s.data.isChildDevice) { childPresent = true; break; }
                    }
                    if (childPresent) status.isOnline = true;
                }
            }
        } catch (_) {}

        res.json(status);
    } catch (e) {
        res.status(500).json({ error: 'Server Error' });
    }
}

// POST /api/status — heartbeat from Android device
function postStatus(req, res) {
    try {
        const body = req.body || {};
        let {
            device_id, deviceId,
            model, manufacturer,
            battery, level,
            version, androidVersion, sdkVersion, appVersion,
            charging,
            lat, lon, latitude, longitude, accuracy, speed,
            network, sim, location
        } = body;

        const rawId = device_id || deviceId;
        if (!rawId) return res.status(400).json({ error: "No ID" });
        const id = rawId.toString().trim().toUpperCase();

        const prev = deviceService.getDevice(id) || {};
        const now = Date.now();

        const batteryVal = battery != null ? Number(battery) : (level != null ? Number(level) : (prev.battery != null ? prev.battery : 0));
        const chargingVal = charging === true || String(charging) === 'true' || String(charging) === '1';
        const modelVal = model || prev.model || 'Unknown';
        const versionVal = androidVersion || version || prev.version || prev.androidVersion || '--';
        const latVal = Number(latitude != null ? latitude : (lat != null ? lat : (prev.lat || 0))) || 0;
        const lonVal = Number(longitude != null ? longitude : (lon != null ? lon : (prev.lon || 0))) || 0;
        const accuracyVal = Number(accuracy != null ? accuracy : (prev.accuracy || 0)) || 0;
        const speedVal = Number(speed != null ? speed : (prev.speed || 0)) || 0;

        deviceService.setDevice(id, {
            model: modelVal,
            manufacturer: manufacturer || prev.manufacturer || null,
            battery: batteryVal,
            version: versionVal,
            androidVersion: versionVal,
            sdkVersion: sdkVersion || prev.sdkVersion || null,
            appVersion: appVersion || prev.appVersion || null,
            charging: chargingVal,
            lat: latVal,
            lon: lonVal,
            accuracy: accuracyVal,
            speed: speedVal,
            lastSeen: now
        });

        const metaFields = {
            model: modelVal,
            lastSeen: now,
            battery: batteryVal,
            charging: chargingVal
        };
        if (manufacturer) metaFields.manufacturer = String(manufacturer);
        if (versionVal && versionVal !== '--') metaFields.androidVersion = String(versionVal);
        if (sdkVersion) metaFields.sdkVersion = String(sdkVersion);
        if (appVersion) metaFields.appVersion = String(appVersion);
        if (network && typeof network === 'object') metaFields.network = network;
        if (sim && typeof sim === 'object') metaFields.sim = sim;

        const locSource = location && typeof location === 'object' ? location : null;
        if (locSource || latVal || lonVal) {
            metaFields.lastLocation = {
                latitude: locSource ? (locSource.latitude != null ? locSource.latitude : locSource.lat) : latVal,
                longitude: locSource ? (locSource.longitude != null ? locSource.longitude : locSource.lon) : lonVal,
                accuracy: locSource && locSource.accuracy != null ? locSource.accuracy : accuracyVal,
                speed: locSource && locSource.speed != null ? locSource.speed : speedVal,
                timestamp: (locSource && locSource.timestamp) || now
            };
        }

        dbService.upsertDevice(id, metaFields).catch(() => {});

        // Push live status to parent dashboards (no wait for 30s poll)
        try {
            const io = global.io;
            if (io) {
                const live = deviceService.getDeviceStatus(id);
                io.emit('device-status', live);
                io.to(id).emit('device-status', live);
            }
        } catch (_) {}

        const commandToSend = deviceService.consumeCommand(id);
        res.json({ status: "success", command: commandToSend });
    } catch (e) {
        res.status(500).json({ error: "Server Error" });
    }
}

module.exports = { getAllDevices, getDeviceStatus, postStatus };
