'use strict';

const User = require('../models/User');
const RefreshToken = require('../models/RefreshToken');
const DeviceMeta = require('../models/DeviceMeta');
const Subscription = require('../models/Subscription');
const Plan = require('../models/Plan');
const Payment = require('../models/Payment');
const DeviceCredential = require('../models/DeviceCredential');
const Setting = require('../models/Setting');
const auditService = require('../services/audit.service');
const authService = require('../services/auth.service');

function getClientIp(req) {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '';
}

// GET /api/admin/dashboard
async function getDashboard(req, res) {
    try {
        const parents = await User.find({ role: 'PARENT' }).select('devices lastLogin activeSubscription').lean();
        const premiumMembers = parents.filter(p => p.activeSubscription).length;

        // Count only verified devices (active credential + matching parent ownership)
        const credentials = await DeviceCredential.find({
            isActive: true,
            ownerUserId: { $ne: null }
        }).select('deviceId ownerUserId').lean();
        const parentById = {};
        parents.forEach(p => { parentById[String(p._id)] = p; });
        const verifiedIds = new Set();
        for (const cred of credentials) {
            const parent = parentById[String(cred.ownerUserId)];
            if (!parent) continue;
            const owned = (parent.devices || []).map(d => String(d).toUpperCase());
            const deviceId = String(cred.deviceId).toUpperCase();
            if (owned.includes(deviceId)) verifiedIds.add(deviceId);
        }

        const [totalParents, activeParents, suspendedParents, activeSubscriptions] = await Promise.all([
            User.countDocuments({ role: 'PARENT' }),
            User.countDocuments({ role: 'PARENT', status: 'active' }),
            User.countDocuments({ role: 'PARENT', status: 'suspended' }),
            Subscription.countDocuments({ status: 'active' }),
        ]);

        const paymentStats = await Payment.aggregate([
            { $match: { status: 'success' } },
            { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
        ]);

        const totalCollection = paymentStats.length > 0 ? paymentStats[0].total : 0;
        const totalPayments = paymentStats.length > 0 ? paymentStats[0].count : 0;

        res.json({
            totalParents,
            activeParents,
            suspendedParents,
            totalDevices: verifiedIds.size,
            activeSubscriptions,
            premiumMembers,
            totalCollection,
            totalPayments,
        });
    } catch (e) {
        res.status(500).json({ error: 'Dashboard data failed' });
    }
}

// GET /api/admin/parents
async function getParents(req, res) {
    try {
        const { search, status, page = 1, limit = 50 } = req.query;
        const query = { role: 'PARENT' };
        if (status) query.status = status;
        if (search) {
            const s = String(search).trim();
            query.$or = [
                { email: { $regex: s, $options: 'i' } },
                { name: { $regex: s, $options: 'i' } },
            ];
        }
        const skip = (Math.max(1, parseInt(page)) - 1) * Math.min(100, parseInt(limit) || 50);
        const [parents, total] = await Promise.all([
            User.find(query)
                .select('-password -emailVerificationToken -passwordResetToken')
                .sort({ registeredAt: -1 })
                .skip(skip)
                .limit(Math.min(100, parseInt(limit) || 50))
                .lean(),
            User.countDocuments(query),
        ]);

        // Enrich parents with subscription and device info
        const enrichedParents = await Promise.all(parents.map(async (parent) => {
            // Get subscription info
            let subscription = null;
            if (parent.activeSubscription) {
                subscription = await Subscription.findById(parent.activeSubscription).populate('planId').lean();
            }

            // Get device count
            const deviceCount = (parent.devices || []).length;

            return {
                ...parent,
                subscription,
                deviceCount,
                isPremium: !!parent.activeSubscription,
            };
        }));

        res.json({ parents: enrichedParents, total, page: parseInt(page), totalPages: Math.ceil(total / (parseInt(limit) || 50)) });
    } catch (e) {
        res.status(500).json({ error: 'Failed to get parents' });
    }
}

// GET /api/admin/parents/:id
async function getParentDetail(req, res) {
    try {
        const parent = await User.findById(req.params.id)
            .select('-password -emailVerificationToken -passwordResetToken')
            .lean();
        if (!parent || parent.role !== 'PARENT') return res.status(404).json({ error: 'Parent not found' });

        // Get devices info
        const deviceIds = (parent.devices || []).map(d => String(d).toUpperCase());
        const devices = deviceIds.length
            ? await DeviceMeta.find({ deviceId: { $in: deviceIds } }).lean()
            : [];

        // Get subscription
        let subscription = null;
        if (parent.activeSubscription) {
            subscription = await Subscription.findById(parent.activeSubscription).populate('planId').lean();
        }

        // Get active sessions
        const activeTokens = await RefreshToken.countDocuments({ userId: parent._id, isRevoked: false, expiresAt: { $gt: new Date() } });

        res.json({ parent, devices, subscription, activeSessions: activeTokens });
    } catch (e) {
        res.status(500).json({ error: 'Failed to get parent details' });
    }
}

// POST /api/admin/parents/:id/suspend
async function suspendParent(req, res) {
    try {
        const { reason } = req.body;
        const parent = await User.findById(req.params.id);
        if (!parent || parent.role !== 'PARENT') return res.status(404).json({ error: 'Parent not found' });

        parent.status = 'suspended';
        parent.suspendedAt = new Date();
        parent.suspendedBy = req.user.email;
        parent.suspendReason = reason || '';
        await parent.save();

        // Force logout
        await authService.forceLogoutUser(parent._id);

        await auditService.logAction({
            action: 'PARENT_SUSPENDED',
            actorId: req.user._id,
            actorEmail: req.user.email,
            actorRole: 'ADMIN',
            targetId: String(parent._id),
            targetType: 'parent',
            details: { reason: reason || '' },
            ip: getClientIp(req),
        });

        res.json({ success: true, message: 'Parent suspended' });
    } catch (e) {
        res.status(500).json({ error: 'Failed to suspend parent' });
    }
}

// POST /api/admin/parents/:id/unsuspend
async function unsuspendParent(req, res) {
    try {
        const parent = await User.findById(req.params.id);
        if (!parent || parent.role !== 'PARENT') return res.status(404).json({ error: 'Parent not found' });

        parent.status = 'active';
        parent.suspendedAt = null;
        parent.suspendedBy = null;
        parent.suspendReason = null;
        await parent.save();

        await auditService.logAction({
            action: 'PARENT_UNSUSPENDED',
            actorId: req.user._id,
            actorEmail: req.user.email,
            actorRole: 'ADMIN',
            targetId: String(parent._id),
            targetType: 'parent',
            ip: getClientIp(req),
        });

        res.json({ success: true, message: 'Parent unsuspended' });
    } catch (e) {
        res.status(500).json({ error: 'Failed to unsuspend parent' });
    }
}

// POST /api/admin/parents/:id/force-logout
async function forceLogout(req, res) {
    try {
        const parent = await User.findById(req.params.id);
        if (!parent || parent.role !== 'PARENT') return res.status(404).json({ error: 'Parent not found' });

        await authService.forceLogoutUser(parent._id);

        await auditService.logAction({
            action: 'PARENT_FORCE_LOGOUT',
            actorId: req.user._id,
            actorEmail: req.user.email,
            actorRole: 'ADMIN',
            targetId: String(parent._id),
            targetType: 'parent',
            ip: getClientIp(req),
        });

        res.json({ success: true, message: 'Parent logged out' });
    } catch (e) {
        res.status(500).json({ error: 'Failed to force logout' });
    }
}

// POST /api/admin/parents/:id/disable
async function disableParent(req, res) {
    try {
        const parent = await User.findById(req.params.id);
        if (!parent || parent.role !== 'PARENT') return res.status(404).json({ error: 'Parent not found' });

        parent.status = 'banned';
        await parent.save();
        await authService.forceLogoutUser(parent._id);

        await auditService.logAction({
            action: 'PARENT_DISABLED',
            actorId: req.user._id,
            actorEmail: req.user.email,
            actorRole: 'ADMIN',
            targetId: String(parent._id),
            targetType: 'parent',
            ip: getClientIp(req),
        });

        res.json({ success: true, message: 'Parent account disabled' });
    } catch (e) {
        res.status(500).json({ error: 'Failed to disable parent' });
    }
}

// POST /api/admin/parents/:id/enable
async function enableParent(req, res) {
    try {
        const parent = await User.findById(req.params.id);
        if (!parent || parent.role !== 'PARENT') return res.status(404).json({ error: 'Parent not found' });

        parent.status = 'active';
        parent.suspendedAt = null;
        parent.suspendedBy = null;
        parent.suspendReason = null;
        await parent.save();

        await auditService.logAction({
            action: 'PARENT_ENABLED',
            actorId: req.user._id,
            actorEmail: req.user.email,
            actorRole: 'ADMIN',
            targetId: String(parent._id),
            targetType: 'parent',
            ip: getClientIp(req),
        });

        res.json({ success: true, message: 'Parent account enabled' });
    } catch (e) {
        res.status(500).json({ error: 'Failed to enable parent' });
    }
}


// Ensure DeviceCredential exists for devices already listed on parents that have real activity.
// Does NOT create credentials for random/test IDs that only appear in User.devices with no meta/activity.
// Does NOT delete any records.
async function ensureCredentialsForOwnedDevices() {
    try {
        const parents = await User.find({ role: 'PARENT' }).select('_id devices').lean();
        const deviceService = require('../services/device.service');
        for (const parent of parents) {
            const ids = (parent.devices || []).map(d => String(d).toUpperCase());
            if (!ids.length) continue;
            const existingCreds = await DeviceCredential.find({ deviceId: { $in: ids } }).lean();
            const credById = {};
            existingCreds.forEach(c => { credById[String(c.deviceId).toUpperCase()] = c; });

            const metas = await DeviceMeta.find({ deviceId: { $in: ids } }).select('deviceId lastSeen').lean();
            const metaById = {};
            metas.forEach(m => { metaById[String(m.deviceId).toUpperCase()] = m; });

            for (const deviceId of ids) {
                const cred = credById[deviceId];
                if (cred && cred.isActive && cred.ownerUserId && String(cred.ownerUserId) === String(parent._id)) {
                    continue; // already verified for this parent
                }
                // Only auto-create when there is evidence of real device activity
                const meta = metaById[deviceId];
                const rt = deviceService.getDeviceStatus(deviceId);
                const hasActivity = !!(
                    (meta && meta.lastSeen) ||
                    (rt && (rt.lastSeen || rt.isOnline || rt.model))
                );
                if (!hasActivity) continue;
                // Do not steal active credentials owned by someone else
                if (cred && cred.isActive && cred.ownerUserId && String(cred.ownerUserId) !== String(parent._id)) {
                    continue;
                }
                await DeviceCredential.findOneAndUpdate(
                    { deviceId },
                    {
                        $set: {
                            deviceId,
                            ownerUserId: parent._id,
                            isActive: true,
                            credentialType: (cred && cred.credentialType) || 'legacy',
                            pairedAt: (cred && cred.pairedAt) || new Date()
                        }
                    },
                    { upsert: true }
                );
            }
        }
    } catch (e) {
        console.error('ensureCredentialsForOwnedDevices:', e.message);
    }
}

// GET /api/admin/devices
// Default list shows ONLY verified/real paired devices:
//   - active DeviceCredential exists
//   - credential.ownerUserId is a PARENT
//   - deviceId is listed on that parent's User.devices
// Offline but legitimately paired devices still appear (status: offline).
// Old/test/orphan DeviceMeta rows without a matching credential are filtered out.
async function getAllDevices(req, res) {
    try {
        await ensureCredentialsForOwnedDevices();
        const { search, page = 1, limit = 50 } = req.query;
        const pageNum = Math.max(1, parseInt(page) || 1);
        const lim = Math.min(100, parseInt(limit) || 50);
        const skip = (pageNum - 1) * lim;

        // 1) Active credentials with an owner
        const credentials = await DeviceCredential.find({
            isActive: true,
            ownerUserId: { $ne: null }
        }).lean();

        if (!credentials.length) {
            return res.json({ devices: [], total: 0, page: pageNum });
        }

        const ownerIds = [...new Set(credentials.map(c => String(c.ownerUserId)))];
        const parents = await User.find({
            _id: { $in: ownerIds },
            role: 'PARENT'
        }).select('_id email name devices lastLogin lastLoginIp registeredAt').lean();

        const parentById = {};
        parents.forEach(p => { parentById[String(p._id)] = p; });

        // 2) Keep only credentials whose owner actually lists this deviceId
        const verified = [];
        for (const cred of credentials) {
            const parent = parentById[String(cred.ownerUserId)];
            if (!parent) continue;
            const owned = (parent.devices || []).map(d => String(d).toUpperCase());
            const deviceId = String(cred.deviceId).toUpperCase();
            if (!owned.includes(deviceId)) continue; // credential owner mismatch / stale
            verified.push({
                deviceId,
                credential: cred,
                owner: {
                    _id: parent._id,
                    email: parent.email,
                    name: parent.name,
                    lastLogin: parent.lastLogin,
                    lastLoginIp: parent.lastLoginIp,
                    registeredAt: parent.registeredAt
                }
            });
        }

        if (!verified.length) {
            return res.json({ devices: [], total: 0, page: pageNum });
        }

        const verifiedIds = verified.map(v => v.deviceId);
        const metaList = await DeviceMeta.find({ deviceId: { $in: verifiedIds } }).lean();
        const metaById = {};
        metaList.forEach(m => { metaById[String(m.deviceId).toUpperCase()] = m; });

        let deviceService;
        try { deviceService = require('../services/device.service'); } catch (_) { deviceService = null; }

        let rows = verified.map(v => {
            const meta = metaById[v.deviceId] || {};
            const rt = deviceService ? deviceService.getDeviceStatus(v.deviceId) : { isOnline: false };
            const lastSeen = meta.lastSeen || (rt.lastSeen || null);

            // Check socket presence: if child socket is in the device room, it's definitely online
            let socketOnline = false;
            try {
                const io = global.io;
                if (io) {
                    const room = io.sockets.adapter.rooms.get(v.deviceId);
                    if (room && room.size > 0) socketOnline = true;
                }
            } catch (_) {}

            const isOnline = !!(socketOnline || rt.isOnline || (lastSeen && (Date.now() - lastSeen) < (5 * 60 * 1000)));
            return {
                deviceId: v.deviceId,
                model: meta.model || rt.model || null,
                manufacturer: meta.manufacturer || null,
                androidVersion: meta.androidVersion || rt.androidVersion || rt.version || null,
                sdkVersion: meta.sdkVersion || null,
                appVersion: meta.appVersion || null,
                battery: meta.battery != null ? meta.battery : (rt.battery != null ? rt.battery : null),
                charging: meta.charging != null ? meta.charging : (rt.charging != null ? rt.charging : null),
                network: meta.network || null,
                sim: meta.sim || null,
                lastLocation: meta.lastLocation || null,
                lastSeen,
                updatedAt: meta.updatedAt || null,
                owner: v.owner,
                isAssigned: true,
                isVerified: true,
                isActive: isOnline,
                status: isOnline ? 'active' : 'offline',
                pairedAt: v.credential.pairedAt || null,
                lastAuthenticated: v.credential.lastAuthenticated || null
            };
        });

        if (search) {
            const s = String(search).trim().toLowerCase();
            rows = rows.filter(d =>
                (d.deviceId && d.deviceId.toLowerCase().includes(s)) ||
                (d.model && String(d.model).toLowerCase().includes(s)) ||
                (d.owner && d.owner.email && d.owner.email.toLowerCase().includes(s)) ||
                (d.owner && d.owner.name && d.owner.name.toLowerCase().includes(s))
            );
        }

        rows.sort((a, b) => {
            if (a.isActive && !b.isActive) return -1;
            if (!a.isActive && b.isActive) return 1;
            return (b.lastSeen || 0) - (a.lastSeen || 0);
        });

        const total = rows.length;
        const pageRows = rows.slice(skip, skip + lim);

        res.json({ devices: pageRows, total, page: pageNum });
    } catch (e) {
        console.error('getAllDevices error:', e);
        res.status(500).json({ error: 'Failed to get devices' });
    }
}

// GET /api/admin/devices/:id
// Returns structured device / network / sim / location / owner for Admin View.
// Never invents values — missing fields are null (frontend shows "Not Available").
async function getDeviceDetail(req, res) {
    try {
        const deviceId = req.params.id.toUpperCase().trim();

        const credential = await DeviceCredential.findOne({
            deviceId,
            isActive: true,
            ownerUserId: { $ne: null }
        }).lean();

        const device = await DeviceMeta.findOne({ deviceId }).lean();

        // Resolve owner: prefer credential owner, verify User.devices contains deviceId
        let owner = null;
        if (credential && credential.ownerUserId) {
            const parent = await User.findOne({
                _id: credential.ownerUserId,
                role: 'PARENT'
            }).select('_id email name lastLogin lastLoginIp registeredAt devices').lean();
            if (parent) {
                const owned = (parent.devices || []).map(d => String(d).toUpperCase());
                if (owned.includes(deviceId)) {
                    owner = {
                        _id: parent._id,
                        email: parent.email,
                        name: parent.name,
                        lastLogin: parent.lastLogin,
                        lastLoginIp: parent.lastLoginIp,
                        registeredAt: parent.registeredAt
                    };
                }
            }
        }
        if (!owner) {
            const fallback = await User.findOne({
                devices: deviceId,
                role: 'PARENT'
            }).select('_id email name lastLogin lastLoginIp registeredAt').lean();
            if (fallback) {
                owner = {
                    _id: fallback._id,
                    email: fallback.email,
                    name: fallback.name,
                    lastLogin: fallback.lastLogin,
                    lastLoginIp: fallback.lastLoginIp,
                    registeredAt: fallback.registeredAt
                };
            }
        }

        // If neither meta nor a verified credential/owner exists, 404
        if (!device && !credential && !owner) {
            return res.status(404).json({ error: 'Device not found' });
        }

        const deviceService = require('../services/device.service');
        const rt = deviceService.getDeviceStatus(deviceId);

        const meta = device || {};
        const net = (meta.network && typeof meta.network === 'object') ? meta.network : {};
        const sim = (meta.sim && typeof meta.sim === 'object') ? meta.sim : {};
        const loc = (meta.lastLocation && typeof meta.lastLocation === 'object') ? meta.lastLocation : {};

        const lastSeen = meta.lastSeen || rt.lastSeen || null;
        const isOnline = !!(rt.isOnline || (lastSeen && (Date.now() - lastSeen) < (5 * 60 * 1000)));

        const battery = meta.battery != null ? meta.battery : (rt.battery != null ? rt.battery : null);
        const charging = meta.charging != null ? meta.charging : (rt.charging != null ? rt.charging : null);

        const lat = loc.latitude != null ? loc.latitude : (loc.lat != null ? loc.lat : (rt.lat != null ? rt.lat : null));
        const lon = loc.longitude != null ? loc.longitude : (loc.lon != null ? loc.lon : (rt.lon != null ? rt.lon : null));

        // Structured response (also flattened fields for backward-compatible frontend)
        const payload = {
            deviceId,
            isAssigned: !!owner,
            isVerified: !!(credential && owner),
            isActive: isOnline,
            isOnline,
            status: isOnline ? 'active' : 'offline',
            lastSeen,
            // Flat fields expected by existing modal
            model: meta.model || rt.model || null,
            manufacturer: meta.manufacturer || null,
            androidVersion: meta.androidVersion || rt.androidVersion || rt.version || null,
            sdkVersion: meta.sdkVersion || null,
            appVersion: meta.appVersion || null,
            battery,
            charging,
            network: Object.keys(net).length ? net : null,
            sim: Object.keys(sim).length ? sim : null,
            lastLocation: Object.keys(loc).length ? loc : null,
            owner: owner || null,
            // Nested sections for richer clients
            device: {
                deviceId,
                model: meta.model || rt.model || null,
                manufacturer: meta.manufacturer || null,
                androidVersion: meta.androidVersion || rt.androidVersion || rt.version || null,
                sdkVersion: meta.sdkVersion || null,
                appVersion: meta.appVersion || null,
                battery,
                charging,
                status: isOnline ? 'active' : 'offline',
                lastSeen
            },
            networkDetail: {
                type: net.type || net.networkType || null,
                wifi: net.wifi != null ? net.wifi : (net.isWifi != null ? net.isWifi : null),
                ssid: net.ssid || null,
                ip: net.ip || net.ipAddress || null,
                ipv4: net.ipv4 || null,
                ipv6: net.ipv6 || null,
                carrier: net.carrier || null,
                operator: net.operator || null,
                signalStrength: net.signalStrength != null ? net.signalStrength : (net.signal != null ? net.signal : null),
                mobileNetworkType: net.mobileNetworkType || net.mobileType || null
            },
            simDetail: {
                count: sim.count != null ? sim.count : (sim.simCount != null ? sim.simCount : null),
                active: sim.active != null ? sim.active : (sim.activeSim != null ? sim.activeSim : null),
                operator: sim.operator || null,
                carrier: sim.carrier || null,
                country: sim.country || sim.countryIso || null,
                phoneNumber: sim.phoneNumber || sim.number || null
            },
            location: {
                latitude: lat,
                longitude: lon,
                accuracy: loc.accuracy != null ? loc.accuracy : (rt.accuracy != null ? rt.accuracy : null),
                speed: loc.speed != null ? loc.speed : (rt.speed != null ? rt.speed : null),
                timestamp: loc.timestamp || null
            }
        };

        res.json(payload);
    } catch (e) {
        console.error('getDeviceDetail error:', e);
        res.status(500).json({ error: 'Failed to get device details' });
    }
}

// GET /api/admin/audit-logs
async function getAuditLogs(req, res) {
    try {
        const { action, actorId, targetId, limit = 100, skip = 0 } = req.query;
        const logs = await auditService.getAuditLogs({
            action, actorId, targetId,
            limit: Math.min(500, parseInt(limit) || 100),
            skip: parseInt(skip) || 0,
        });
        res.json({ logs });
    } catch (e) {
        res.status(500).json({ error: 'Failed to get audit logs' });
    }
}

// GET /api/admin/subscriptions
async function getSubscriptions(req, res) {
    try {
        const subs = await Subscription.find({})
            .populate('userId', 'email name')
            .populate('planId', 'name slug price billingPeriod')
            .sort({ createdAt: -1 })
            .limit(200)
            .lean();
        res.json({ subscriptions: subs });
    } catch (e) {
        res.status(500).json({ error: 'Failed to get subscriptions' });
    }
}

// GET /api/admin/payments
async function getPayments(req, res) {
    try {
        const payments = await Payment.find({})
            .populate('userId', 'email name')
            .populate('planId', 'name price')
            .sort({ createdAt: -1 })
            .limit(200)
            .lean();
        res.json({ payments });
    } catch (e) {
        res.status(500).json({ error: 'Failed to get payments' });
    }
}

// Video Management
const Video = require('../models/Video');
const cloudinary = require('../config/cloudinary');

async function getVideos(req, res) {
    try {
        const videos = await Video.find({}).sort({ createdAt: -1 });
        res.json({ videos });
    } catch (e) {
        res.status(500).json({ error: 'Failed to get videos' });
    }
}

async function uploadVideo(req, res) {
    try {
        const { type } = req.body;
        if (!type || !req.file) {
            return res.status(400).json({ error: 'Type and video file required' });
        }

        const fs = require('fs');
        const filePath = req.file.path;

        // Upload to Cloudinary using upload_large for chunked transfer (handles 300MB)
        const result = await new Promise((resolve, reject) => {
            cloudinary.uploader.upload_large(filePath,
                {
                    resource_type: 'video',
                    folder: 'parental-control/videos',
                    chunk_size: 6 * 1024 * 1024 // 6MB chunks
                },
                (error, result) => {
                    // Clean up temp file
                    try { fs.unlinkSync(filePath); } catch (_) {}
                    if (error) reject(error);
                    else resolve(result);
                }
            );
        });

        // Save to database
        const video = await Video.create({
            type,
            url: result.secure_url,
            cloudinaryId: result.public_id,
            uploadedBy: req.user._id,
        });

        res.json({ video, message: 'Video uploaded successfully' });
    } catch (e) {
        // Clean up temp file on error
        if (req.file && req.file.path) {
            try { require('fs').unlinkSync(req.file.path); } catch (_) {}
        }
        console.error('Upload video error:', e);
        res.status(500).json({ error: 'Failed to upload video' });
    }
}

async function deleteVideo(req, res) {
    try {
        const video = await Video.findById(req.params.id);
        if (!video) return res.status(404).json({ error: 'Video not found' });

        // Delete from Cloudinary
        await cloudinary.uploader.destroy(video.cloudinaryId, { resource_type: 'video' });
        if (video.thumbnailId) {
            await cloudinary.uploader.destroy(video.thumbnailId);
        }

        // Delete from database
        await Video.findByIdAndDelete(req.params.id);

        res.json({ message: 'Video deleted successfully' });
    } catch (e) {
        res.status(500).json({ error: 'Failed to delete video' });
    }
}

// ─── Video Thumbnail Upload ────────────────────────────────────────────────
async function uploadVideoThumbnail(req, res) {
    try {
        const { videoId } = req.params;
        if (!req.file) return res.status(400).json({ error: 'Thumbnail image required' });

        const video = await Video.findById(videoId);
        if (!video) return res.status(404).json({ error: 'Video not found' });

        // Delete old thumbnail if exists
        if (video.thumbnailId) {
            await cloudinary.uploader.destroy(video.thumbnailId);
        }

        // Upload new thumbnail
        const result = await new Promise((resolve, reject) => {
            const stream = cloudinary.uploader.upload_stream(
                { resource_type: 'image', folder: 'parental-control/thumbnails' },
                (error, result) => {
                    if (error) reject(error);
                    else resolve(result);
                }
            );
            stream.end(req.file.buffer);
        });

        // Update video
        video.thumbnail = result.secure_url;
        video.thumbnailId = result.public_id;
        await video.save();

        res.json({ video, message: 'Thumbnail uploaded' });
    } catch (e) {
        console.error('Upload thumbnail error:', e);
        res.status(500).json({ error: 'Failed to upload thumbnail' });
    }
}

// ─── APK URL Setting ───────────────────────────────────────────────────────
async function getApkUrl(req, res) {
    try {
        const url = await Setting.get('apk_download_url', 'https://files.catbox.moe/9sve3e.apk');
        res.json({ url });
    } catch (e) {
        res.status(500).json({ error: 'Failed to get APK URL' });
    }
}

async function setApkUrl(req, res) {
    try {
        const { url } = req.body;
        if (!url || !url.startsWith('http')) {
            return res.status(400).json({ error: 'Valid URL required' });
        }
        await Setting.set('apk_download_url', url, 'APK download URL for users');
        res.json({ success: true, message: 'APK URL updated' });
    } catch (e) {
        res.status(500).json({ error: 'Failed to set APK URL' });
    }
}

// Admin Settings
async function changeAdminName(req, res) {
    try {
        const { name } = req.body;
        if (!name || name.trim().length < 2) {
            return res.status(400).json({ error: 'Name must be at least 2 characters' });
        }

        await User.findByIdAndUpdate(req.user._id, { name: name.trim() });
        
        await auditService.log({
            action: 'admin_name_changed',
            actorId: req.user._id,
            actorEmail: req.user.email,
            ip: getClientIp(req),
        });

        res.json({ message: 'Name updated successfully', name: name.trim() });
    } catch (e) {
        res.status(500).json({ error: 'Failed to update name' });
    }
}

async function changeAdminPassword(req, res) {
    try {
        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword) {
            return res.status(400).json({ error: 'Current and new password required' });
        }
        if (newPassword.length < 8) {
            return res.status(400).json({ error: 'New password must be at least 8 characters' });
        }

        // Verify current password
        const user = await User.findById(req.user._id);
        const isMatch = await user.comparePassword(currentPassword);
        if (!isMatch) {
            return res.status(400).json({ error: 'Current password is incorrect' });
        }

        // Update password
        user.password = newPassword;
        await user.save();

        // Invalidate all refresh tokens
        await RefreshToken.deleteMany({ userId: req.user._id });

        await auditService.log({
            action: 'admin_password_changed',
            actorId: req.user._id,
            actorEmail: req.user.email,
            ip: getClientIp(req),
        });

        res.json({ message: 'Password changed successfully' });
    } catch (e) {
        res.status(500).json({ error: 'Failed to change password' });
    }
}

// ── Individual Feature Lock/Unlock ──────────────────────────────────────────
// All features that can be individually locked/unlocked by admin
const ALL_FEATURES = [
    { key: 'screen', label: 'Screen Monitor', icon: 'fa-mobile-screen', category: 'monitoring' },
    { key: 'camera', label: 'Camera', icon: 'fa-camera', category: 'monitoring' },
    { key: 'location', label: 'Location', icon: 'fa-location-dot', category: 'monitoring' },
    { key: 'audio', label: 'Audio Record', icon: 'fa-microphone', category: 'monitoring' },
    { key: 'gallery', label: 'Gallery', icon: 'fa-images', category: 'monitoring' },
    { key: 'notifications', label: 'Notifications', icon: 'fa-message', category: 'monitoring' },
    { key: 'whatsapp', label: 'WhatsApp', icon: 'fa-whatsapp', category: 'social' },
    { key: 'instagram', label: 'Instagram', icon: 'fa-instagram', category: 'social' },
    { key: 'snap', label: 'Snapchat', icon: 'fa-snapchat', category: 'social' },
    { key: 'apps', label: 'Apps List', icon: 'fa-google-play', category: 'monitoring' },
    { key: 'call_logs', label: 'Call Logs', icon: 'fa-phone', category: 'monitoring' },
    { key: 'contacts', label: 'Contacts', icon: 'fa-address-book', category: 'monitoring' },
    { key: 'sms', label: 'SMS', icon: 'fa-comments', category: 'monitoring' },
    { key: 'websites', label: 'Websites', icon: 'fa-globe', category: 'monitoring' },
    { key: 'recording', label: 'Call Recording', icon: 'fa-circle-dot', category: 'monitoring' },
    { key: 'snapshot', label: 'Snapshot', icon: 'fa-camera-rotate', category: 'monitoring' },
    { key: 'saved_files', label: 'Saved Files', icon: 'fa-cloud-arrow-down', category: 'files' },
    { key: 'storage', label: 'Storage', icon: 'fa-folder-open', category: 'files' },
    { key: 'network', label: 'Network Info', icon: 'fa-wifi', category: 'device' },
    { key: 'security', label: 'Security', icon: 'fa-shield-halved', category: 'device' },
    { key: 'live_activity', label: 'Live Activity', icon: 'fa-pulse', category: 'monitoring' },
    { key: 'command', label: 'Remote Commands', icon: 'fa-terminal', category: 'device' },
];

// GET /api/admin/settings/features
async function getFeatureLocks(req, res) {
    try {
        const featureLocks = await Setting.get('featureLocks', {});
        // Return all features with their lock status (true = locked, false = unlocked)
        const features = ALL_FEATURES.map(f => ({
            ...f,
            locked: !!featureLocks[f.key],
        }));
        res.json({ features });
    } catch (e) {
        res.status(500).json({ error: 'Failed to get feature locks' });
    }
}

// POST /api/admin/settings/features/:featureKey
async function setFeatureLock(req, res) {
    try {
        const { featureKey } = req.params;
        const { locked } = req.body;

        // Validate feature key
        const feature = ALL_FEATURES.find(f => f.key === featureKey);
        if (!feature) {
            return res.status(400).json({ error: 'Invalid feature key' });
        }

        // Get current locks
        const featureLocks = await Setting.get('featureLocks', {});
        featureLocks[featureKey] = !!locked;
        await Setting.set('featureLocks', featureLocks, 'Individual feature lock settings');

        await auditService.logAction({
            action: 'FEATURE_LOCK_TOGGLED',
            actorId: req.user._id,
            actorEmail: req.user.email,
            actorRole: 'ADMIN',
            targetType: 'setting',
            targetId: featureKey,
            details: { feature: featureKey, locked: !!locked },
            ip: getClientIp(req),
        });

        res.json({ success: true, feature: featureKey, locked: !!locked });
    } catch (e) {
        res.status(500).json({ error: 'Failed to update feature lock' });
    }
}

// POST /api/admin/settings/features-lock-all
async function lockAllFeatures(req, res) {
    try {
        const { locked } = req.body;
        const featureLocks = {};
        ALL_FEATURES.forEach(f => { featureLocks[f.key] = !!locked; });
        await Setting.set('featureLocks', featureLocks, 'Individual feature lock settings');

        await auditService.logAction({
            action: 'ALL_FEATURES_LOCK_TOGGLED',
            actorId: req.user._id,
            actorEmail: req.user.email,
            actorRole: 'ADMIN',
            targetType: 'setting',
            targetId: 'allFeatures',
            details: { locked: !!locked },
            ip: getClientIp(req),
        });

        res.json({ success: true, locked: !!locked });
    } catch (e) {
        res.status(500).json({ error: 'Failed to lock/unlock all features' });
    }
}


/**
 * Admin: permanently delete a device ID and all related DB data.
 * Parent user account is kept; device is removed from their devices list
 * so the same ID can be paired again later (or a new device added).
 */

async function deleteDeviceFully(req, res) {
    try {
        const deviceId = String(req.params.id || req.body.deviceId || '').trim().toUpperCase();
        if (!deviceId) {
            return res.status(400).json({ error: 'Device ID required' });
        }

        const summary = {
            deviceId,
            usersUpdated: 0,
            credentials: 0,
            meta: 0,
            history: 0,
            activity: 0,
            boot: 0,
            chat: 0,
            uploadFiles: 0,
        };

        // Case-insensitive match helper for Mongo string fields
        const idMatch = {
            $expr: { $eq: [{ $toUpper: { $ifNull: ['$deviceId', ''] } }, deviceId] }
        };

        // 1) Remove from ALL parents' devices arrays (any casing)
        const parents = await User.find({ role: 'PARENT' }).select('_id devices');
        for (const p of parents) {
            const list = p.devices || [];
            const filtered = list.filter(d => String(d).trim().toUpperCase() !== deviceId);
            if (filtered.length !== list.length) {
                p.devices = filtered;
                await p.save();
                summary.usersUpdated += 1;
            }
        }

        // 2) Credentials (hard delete, any casing)
        summary.credentials = (await DeviceCredential.deleteMany(idMatch)).deletedCount || 0;
        // Fallback exact
        summary.credentials += (await DeviceCredential.deleteMany({ deviceId })).deletedCount || 0;

        // 3) Meta
        summary.meta = (await DeviceMeta.deleteMany(idMatch)).deletedCount || 0;
        summary.meta += (await DeviceMeta.deleteMany({ deviceId })).deletedCount || 0;

        // 4) Related collections
        try {
            const History = require('../models/History');
            summary.history = (await History.deleteMany(idMatch)).deletedCount || 0;
            summary.history += (await History.deleteMany({ deviceId })).deletedCount || 0;
        } catch (_) {}
        try {
            const ActivityEvent = require('../models/ActivityEvent');
            summary.activity = (await ActivityEvent.deleteMany(idMatch)).deletedCount || 0;
            summary.activity += (await ActivityEvent.deleteMany({ deviceId })).deletedCount || 0;
        } catch (_) {}
        try {
            const BootStatus = require('../models/BootStatus');
            summary.boot = (await BootStatus.deleteMany(idMatch)).deletedCount || 0;
            summary.boot += (await BootStatus.deleteMany({ deviceId })).deletedCount || 0;
        } catch (_) {}
        try {
            const ChatMessage = require('../models/ChatMessage');
            summary.chat = (await ChatMessage.deleteMany(idMatch)).deletedCount || 0;
            summary.chat += (await ChatMessage.deleteMany({ deviceId })).deletedCount || 0;
        } catch (_) {}

        // 5) Memory
        try {
            const deviceService = require('../services/device.service');
            if (deviceService.removeDevice) deviceService.removeDevice(deviceId);
            else {
                if (deviceService.setCommand) deviceService.setCommand(deviceId, null);
            }
        } catch (_) {}

        // 6) Upload files
        try {
            const fs = require('fs');
            const path = require('path');
            const uploadsDir = path.join(__dirname, '..', 'uploads');
            if (fs.existsSync(uploadsDir)) {
                for (const name of fs.readdirSync(uploadsDir)) {
                    const up = name.toUpperCase();
                    if (up.startsWith(deviceId + '_') || up.startsWith(deviceId + '.') || up.includes('_' + deviceId + '_')) {
                        try {
                            fs.unlinkSync(path.join(uploadsDir, name));
                            summary.uploadFiles += 1;
                        } catch (_) {}
                    }
                }
            }
        } catch (_) {}

        try {
            await auditService.logAction({
                action: 'DEVICE_DELETED',
                actorId: req.user && req.user._id,
                actorEmail: req.user && req.user.email,
                actorRole: 'ADMIN',
                targetId: deviceId,
                targetType: 'device',
                details: { summary },
                ip: getClientIp(req),
            });
        } catch (_) {}

        // Final sweep: any leftover devices array entries / credentials
        try {
            const again = await User.find({ role: 'PARENT' }).select('_id devices');
            for (const p of again) {
                const list = p.devices || [];
                const filtered = list.filter(d => String(d).trim().toUpperCase() !== deviceId);
                if (filtered.length !== list.length) {
                    p.devices = filtered;
                    await p.save();
                    summary.usersUpdated += 1;
                }
            }
            await DeviceCredential.deleteMany({
                $or: [
                    { deviceId: deviceId },
                    { deviceId: deviceId.toLowerCase() },
                    { $expr: { $eq: [{ $toUpper: { $ifNull: ['$deviceId', ''] } }, deviceId] } }
                ]
            });
        } catch (_) {}

        res.json({
            success: true,
            message: 'Device removed from all parent accounts and database. Counts will update on refresh.',
            summary,
        });
    } catch (e) {
        console.error('deleteDeviceFully error:', e);
        res.status(500).json({ error: e.message || 'Failed to delete device' });
    }
}

module.exports = {
    getDashboard, getParents, getParentDetail,
    suspendParent, unsuspendParent, forceLogout,
    disableParent, enableParent,
    getAllDevices, getDeviceDetail, deleteDeviceFully, getAuditLogs,
    getSubscriptions, getPayments,
    getVideos, uploadVideo, deleteVideo, uploadVideoThumbnail,
    changeAdminName, changeAdminPassword,
    getFeatureLocks, setFeatureLock, lockAllFeatures,
    getApkUrl, setApkUrl,
    ALL_FEATURES,
};
