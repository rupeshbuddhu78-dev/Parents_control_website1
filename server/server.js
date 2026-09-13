'use strict';

const http = require('http');
const { Server } = require('socket.io');
const env = require('./config/env');
const { connect } = require('./config/db');
const createApp = require('./app');

function normalizeDeviceId(raw) {
    if (!raw) return '';
    let id = String(raw).trim();
    // Strip room suffixes like _screen, _camera
    id = id.replace(/_screen$/i, '').replace(/_camera$/i, '').replace(/_gallery$/i, '');
    return id.toUpperCase();
}

async function start() {
    const missing = env.validateRequired();
    if (missing.length) {
        console.error('Missing required env vars:', missing.join(', '));
        process.exit(1);
    }

    const ok = await connect();
    if (!ok) {
        console.error('Failed to connect to MongoDB. Check MONGODB_URI.');
    } else {
        try {
            const { repairRefreshTokenIndexes } = require('./models/RefreshToken');
            await repairRefreshTokenIndexes();
        } catch (e) {
            console.warn('[startup] RefreshToken repair:', e.message);
        }
    }

    // Mutable io holder so routes can emit before Server is fully ready
    const ioHolder = {
        to() { return { emit() {} }; },
        emit() {},
        on() {},
    };

    const app = createApp(ioHolder);
    const server = http.createServer(app);

    const io = new Server(server, {
        path: '/socket.io',
        cors: {
            origin: process.env.CORS_ORIGINS
                ? process.env.CORS_ORIGINS.split(',').map((s) => s.trim())
                : '*',
            methods: ['GET', 'POST'],
            credentials: true,
        },
        maxHttpBufferSize: 10e6,
        pingTimeout: 120000,
        pingInterval: 30000,
        transports: ['websocket', 'polling'],
        allowEIO3: true,
    });

    // Bridge holder -> real io (routes closed over ioHolder)
    ioHolder.to = (...args) => io.to(...args);
    ioHolder.emit = (...args) => io.emit(...args);
    ioHolder.on = (...args) => io.on(...args);
    global.io = io;

    // Optional device service for HTTP command queue fallback
    let deviceService = null;
    try { deviceService = require('./services/device.service'); } catch (_) {}

    io.on('connection', (socket) => {
        console.log('[Socket] connected', socket.id);

        // Track which device rooms this socket has joined (for online/offline status)
        const deviceRooms = new Set();

        socket.on('join-room', (roomOrObj) => {
            if (!roomOrObj) return;
            // Support string (legacy) or { room, role: 'parent'|'device' }
            let roomId = '';
            let role = 'unknown';
            if (typeof roomOrObj === 'object') {
                roomId = String(roomOrObj.room || roomOrObj.deviceId || roomOrObj.targetId || '').trim();
                role = String(roomOrObj.role || roomOrObj.as || 'unknown').toLowerCase();
            } else {
                roomId = String(roomOrObj).trim();
            }
            if (!roomId) return;
            socket.join(roomId);
            const base = normalizeDeviceId(roomId);
            if (base && base !== roomId) socket.join(base);

            // Only REAL child device marks online — parent dashboard join must NOT
            // (bug: parent in same room forced "Connected" forever even if app deleted / net off)
            const isChild = (role === 'device' || role === 'child' || role === 'phone');
            if (isChild && base && !roomId.endsWith('_screen') && !roomId.endsWith('_camera') && !roomId.endsWith('_gallery')) {
                socket.data.isChildDevice = true;
                socket.data.childDeviceId = base;
                deviceRooms.add(base);
                try {
                    const ds = require('./services/device.service');
                    const prev = ds.getDevice(base) || {};
                    ds.setDevice(base, { ...prev, lastSeen: Date.now(), socketOnline: true });
                    io.emit('device-status', { deviceId: base, isOnline: true, lastSeen: Date.now() });
                } catch (_) {}
            }
            console.log('[Socket]', socket.id, 'joined', roomId, 'role=' + role);
        });

        socket.on('join', (room) => {
            if (!room) return;
            const roomId = String(room).trim();
            socket.join(roomId);
            const base = normalizeDeviceId(roomId);
            if (base) socket.join(base);
            console.log('[Socket]', socket.id, 'join', roomId);
        });

        // Parent dashboard: socket.emit('send-command', { command, targetId, ... })
        socket.on('send-command', async (payload) => {
            try {
                if (!payload) return;
                const command = typeof payload === 'string' ? payload : (payload.command || payload.action);
                if (!command) return;

                const targetRaw = (payload && (payload.targetId || payload.deviceId || payload.device_id || payload.room)) || '';
                const deviceId = normalizeDeviceId(targetRaw);
                if (!deviceId) {
                    console.warn('[Socket] send-command missing target', payload);
                    socket.emit('command-error', { error: 'Missing targetId', command });
                    return;
                }

                // Require parent JWT (payload.token or handshake.auth.token)
                const jwt = require('jsonwebtoken');
                const token = (payload && payload.token) || (socket.handshake.auth && socket.handshake.auth.token) || '';
                if (!token) {
                    socket.emit('command-error', { error: 'Authentication required', command });
                    return;
                }
                let decoded;
                try {
                    decoded = jwt.verify(token, env.JWT_SECRET);
                } catch (err) {
                    socket.emit('command-error', { error: 'Invalid or expired token', command });
                    return;
                }
                if (decoded.role !== 'ADMIN') {
                    const { verifyDeviceOwnershipSync } = require('./middleware/deviceOwnership');
                    const check = await verifyDeviceOwnershipSync(decoded.sub, deviceId, decoded.role);
                    if (!check.allowed) {
                        socket.emit('command-error', { error: check.reason || 'Device not owned', command });
                        return;
                    }
                }

                const cmdPayload = typeof payload === 'object' ? { ...payload, command } : command;
                // Never forward token to child
                if (cmdPayload && typeof cmdPayload === 'object') delete cmdPayload.token;

                // Emit once to base device room only (avoid multi-room duplicate on same client)
                io.to(deviceId).emit('command', cmdPayload);

                if (deviceService) {
                    try {
                        deviceService.setCommand(deviceId, typeof cmdPayload === 'string' ? cmdPayload : command);
                    } catch (_) {}
                }

                console.log(`[Socket] command "${command}" -> ${deviceId} (from ${socket.id})`);
                socket.emit('command-ack', { command, targetId: deviceId });
            } catch (e) {
                console.error('[Socket] send-command error', e.message);
                socket.emit('command-error', { error: e.message });
            }
        });

        // ── SCREEN FRAME RELAY: volatile emit to drop frames under congestion ──
        // screen-frame events are high-frequency binary data. Using volatile emit
        // ensures the server drops frames instead of buffering them when the client
        // can't keep up, preventing the "fast-forward" effect on recovery.
        socket.on('screen-frame', (metadata, jpeg) => {
            if (!metadata || typeof metadata !== 'object') return;
            const payload = { ...metadata, senderSocketId: socket.id };
            
            // Direct to a specific socket (child -> parent)
            if (payload.targetSocketId) {
                io.to(payload.targetSocketId).volatile.emit('screen-frame', payload, jpeg);
                return;
            }
            
            // Room fan-out
            const room = payload.target || payload.deviceId || payload.device_id || payload.targetRoom || payload.targetId;
            if (room) {
                const roomStr = String(room);
                const base = normalizeDeviceId(roomStr);
                socket.to(roomStr).volatile.emit('screen-frame', payload, jpeg);
                if (base && base !== roomStr) {
                    socket.to(base).volatile.emit('screen-frame', payload, jpeg);
                }
                if (base) {
                    socket.to(base + '_screen').volatile.emit('screen-frame', payload, jpeg);
                }
            }
        });

        // ── AUDIO STREAM RELAY: child sends raw binary PCM, no metadata ──
        // The child app emits audio-stream as a bare byte[] with no routing info.
        // We relay to all rooms the child socket has joined (except _screen/_camera
        // suffix rooms) so the parent in the same device room receives the audio.
        // Uses volatile emit so the server drops chunks instead of buffering when
        // the parent can't keep up (prevents latency buildup).
        socket.on('audio-stream', (audioData) => {
            const rooms = Array.from(socket.rooms).filter(r =>
                r !== socket.id && !r.endsWith('_screen') && !r.endsWith('_camera') && !r.endsWith('_gallery')
            );
            for (const room of rooms) {
                socket.to(room).volatile.emit('audio-stream', audioData);
            }
        });

        // Screen / gallery / camera WebRTC signaling + generic relay
        const relayEvents = [
            'screen-p2p-request', 'screen-offer', 'screen-answer', 'screen-candidate',
            'gallery-request', 'gallery-offer', 'gallery-answer', 'gallery-candidate',
            'gallery-error', 'gallery-fallback-request', 'gallery-fallback-complete',
            'gallery-relay-start', 'gallery-relay-manifest', 'gallery-relay-file-start',
            'gallery-relay-chunk', 'gallery-relay-file-end', 'gallery-relay-complete',
            'gallery-relay-end', 'gallery-delete', 'gallery-delete-ack',
            'camera-offer', 'camera-answer', 'camera-candidate',
            'webrtc-offer', 'webrtc-answer', 'webrtc-candidate',
            'offer', 'answer', 'candidate',
            'control-event',
            'switch-camera',
        ];

        for (const event of relayEvents) {
            socket.on(event, (data) => {
                if (!data || typeof data !== 'object') return;

                // Always tag sender
                const payload = { ...data, senderSocketId: socket.id };
                // Parent gallery-request must include parentSocketId for the child
                if (event === 'gallery-request' || event === 'gallery-fallback-request' || event === 'gallery-relay-start') {
                    if (!payload.parentSocketId) payload.parentSocketId = socket.id;
                }
                // gallery-delete: child app reads "requesterSocketId" (not senderSocketId)
                // so we alias it here to keep the ack routing working
                if (event === 'gallery-delete') {
                    payload.requesterSocketId = payload.requesterSocketId || socket.id;
                    // Server-side Cloudinary delete fallback: if the item has a publicId,
                    // delete from Cloudinary directly so the delete succeeds even if the
                    // child app cannot reach Cloudinary or the source file is already gone.
                    const pubId = payload.publicId || payload.public_id || '';
                    const resType = payload.resourceType || 'image';
                    if (pubId && !pubId.includes('..')) {
                        try {
                            const cloudinary = require('./config/cloudinary');
                            cloudinary.uploader.destroy(pubId, { resource_type: resType, invalidate: true }, (err, result) => {
                                if (err) {
                                    console.warn('[Socket] server-side Cloudinary delete failed for', pubId, err.message);
                                } else {
                                    console.log('[Socket] server-side Cloudinary delete ok', pubId, result && result.result);
                                    // Send ack directly from server in case child cannot
                                    try {
                                        io.to(socket.id).emit('gallery-delete-ack', {
                                            requestId: payload.requestId || '',
                                            id: payload.id || '',
                                            deleted: true,
                                            sourceDeleted: false,
                                            cloudinaryDeleted: true,
                                            error: ''
                                        });
                                    } catch (_) {}
                                }
                            });
                        } catch (e) {
                            console.warn('[Socket] server-side Cloudinary destroy error:', e.message);
                        }
                    }
                }

                // Direct to a specific socket (child -> parent)
                if (payload.targetSocketId) {
                    io.to(payload.targetSocketId).emit(event, payload);
                    console.log(`[Socket] relay ${event} -> socket ${payload.targetSocketId}`);
                }

                // ALSO room fan-out so parent still receives if socket id is stale
                // Parent UI uses `target`; other paths use deviceId / targetId
                const room = payload.target || payload.deviceId || payload.device_id
                    || payload.targetRoom || payload.targetId;
                if (room) {
                    const roomStr = String(room);
                    const base = normalizeDeviceId(roomStr);
                    socket.to(roomStr).emit(event, payload);
                    if (base && base !== roomStr) {
                        socket.to(base).emit(event, payload);
                    }
                    if (base) {
                        socket.to(base + '_screen').emit(event, payload);
                        socket.to(base + '_gallery').emit(event, payload);
                        socket.to(base + '_camera').emit(event, payload);
                    }
                    console.log(`[Socket] relay ${event} -> room ${roomStr}` + (base && base !== roomStr ? ` (+${base})` : ''));
                    return;
                }

                if (!payload.targetSocketId) {
                    socket.broadcast.emit(event, payload);
                }
            });
        }

        socket.on('disconnect', (reason) => {
            console.log('[Socket] disconnected', socket.id, reason);
            // Only child-device sockets affect online status (not parent browser tabs)
            if (socket.data && socket.data.isChildDevice && socket.data.childDeviceId) {
                const room = socket.data.childDeviceId;
                try {
                    // If another child socket still in room, stay online
                    const socketsInRoom = io.sockets.adapter.rooms.get(room);
                    let childStillThere = false;
                    if (socketsInRoom) {
                        for (const sid of socketsInRoom) {
                            const s = io.sockets.sockets.get(sid);
                            if (s && s.data && s.data.isChildDevice && s.id !== socket.id) {
                                childStillThere = true;
                                break;
                            }
                        }
                    }
                    if (!childStillThere) {
                        const ds = require('./services/device.service');
                        const prev = ds.getDevice(room) || {};
                        // Do not refresh lastSeen — allow 90s timeout from last real status
                        ds.setDevice(room, { ...prev, socketOnline: false });
                        const lastSeen = prev.lastSeen || 0;
                        const stillFresh = lastSeen && (Date.now() - lastSeen) < 35000;
                        io.emit('device-status', {
                            deviceId: room,
                            isOnline: !!stillFresh,
                            lastSeen: lastSeen
                        });
                    }
                } catch (_) {}
            }
        });
    });

    const PORT = env.PORT || process.env.PORT || 3000;
    server.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
        console.log(`Environment: ${env.NODE_ENV}`);
    });
}

start().catch((err) => {
    console.error('Fatal start error:', err);
    process.exit(1);
});
