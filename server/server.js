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
        pingTimeout: 60000,
        pingInterval: 25000,
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

        socket.on('join-room', (room) => {
            if (!room) return;
            const roomId = String(room).trim();
            socket.join(roomId);
            // Also join normalized device room
            const base = normalizeDeviceId(roomId);
            if (base && base !== roomId) socket.join(base);
            console.log('[Socket]', socket.id, 'joined', roomId, base && base !== roomId ? `(+${base})` : '');
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
        socket.on('send-command', (payload) => {
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

                // Child listens on event "command" (string or {command})
                const cmdPayload = typeof payload === 'object' ? { ...payload, command } : command;

                io.to(deviceId).emit('command', cmdPayload);
                io.to(deviceId + '_screen').emit('command', cmdPayload);
                io.to(deviceId + '_camera').emit('command', cmdPayload);

                // HTTP polling fallback queue
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
