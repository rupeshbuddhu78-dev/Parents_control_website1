'use strict';

const jwt = require('jsonwebtoken');
const env = require('../config/env');
const User = require('../models/User');

/**
 * Authenticate parent/admin user via JWT access token.
 * Attaches req.user with { _id, email, role, status }.
 */
function authenticateUser(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Authentication required' });
    }

    const token = authHeader.slice(7);
    if (!token) return res.status(401).json({ error: 'Token missing' });

    try {
        const decoded = jwt.verify(token, env.JWT_SECRET);
        // Attach minimal user info; full lookup done if needed
        req.user = {
            _id: decoded.sub,
            email: decoded.email,
            role: decoded.role,
            status: decoded.status || 'active',
        };
        next();
    } catch (err) {
        if (err.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
        }
        return res.status(401).json({ error: 'Invalid token' });
    }
}

/**
 * Require the authenticated user to be an ADMIN.
 */
function requireAdmin(req, res, next) {
    if (!req.user || req.user.role !== 'ADMIN') {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
}

/**
 * Require the authenticated user to be a PARENT (not admin).
 */
function requireParent(req, res, next) {
    if (!req.user || req.user.role !== 'PARENT') {
        return res.status(403).json({ error: 'Parent access required' });
    }
    next();
}

/**
 * Check that the user account is active (not suspended/banned).
 */
async function checkAccountStatus(req, res, next) {
    if (!req.user || !req.user._id) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    try {
        const user = await User.findById(req.user._id).select('status').lean();
        if (!user) return res.status(401).json({ error: 'Account not found' });
        if (user.status === 'suspended') {
            return res.status(403).json({ error: 'Account suspended', code: 'ACCOUNT_SUSPENDED' });
        }
        if (user.status === 'banned') {
            return res.status(403).json({ error: 'Account banned', code: 'ACCOUNT_BANNED' });
        }
        req.user.status = user.status;
        next();
    } catch (e) {
        return res.status(500).json({ error: 'Account check failed' });
    }
}

/**
 * Optional auth - attaches user if token present, but doesn't reject if missing.
 */
function optionalAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return next();
    }
    const token = authHeader.slice(7);
    try {
        const decoded = jwt.verify(token, env.JWT_SECRET);
        req.user = {
            _id: decoded.sub,
            email: decoded.email,
            role: decoded.role,
            status: decoded.status || 'active',
        };
    } catch (err) {
        // Token invalid/expired - just continue without user
    }
    next();
}

/**
 * Check if user has active premium subscription.
 * Attaches req.hasPremium (boolean) and req.subscription (if active).
 * Does NOT reject - use for feature gating, not access control.
 */
async function checkPremiumAccess(req, res, next) {
    if (!req.user || !req.user._id) {
        req.hasPremium = false;
        return next();
    }
    
    try {
        const Subscription = require('../models/Subscription');
        const User = require('../models/User');
        
        const user = await User.findById(req.user._id).select('activeSubscription').lean();
        if (!user || !user.activeSubscription) {
            req.hasPremium = false;
            return next();
        }
        
        const subscription = await Subscription.findById(user.activeSubscription)
            .populate('planId')
            .lean();
        
        if (!subscription || subscription.status !== 'active') {
            req.hasPremium = false;
            return next();
        }
        
        // Check if expired
        if (subscription.expiryDate < new Date()) {
            // Mark as expired
            await Subscription.findByIdAndUpdate(subscription._id, { status: 'expired' });
            req.hasPremium = false;
            return next();
        }
        
        req.hasPremium = true;
        req.subscription = subscription;
        next();
    } catch (e) {
        req.hasPremium = false;
        next();
    }
}


/**
 * Child-device endpoints: require device_id to be an active paired DeviceCredential.
 * Does NOT require parent JWT — keeps Android uploads/status working.
 * Blocks random unregistered device IDs from abusing open APIs.
 */
async function requirePairedDevice(req, res, next) {
    try {
        const DeviceCredential = require('../models/DeviceCredential');
        const User = require('../models/User');
        const raw = (
            req.params.device_id || req.params.deviceId || req.params.id ||
            req.body.device_id || req.body.deviceId ||
            req.query.device || req.query.deviceId || req.query.device_id ||
            req.headers['x-device-id'] || ''
        ).toString().trim().toUpperCase();
        if (!raw) {
            return res.status(400).json({ error: 'Device ID required' });
        }

        let cred = await DeviceCredential.findOne({
            deviceId: raw,
            isActive: true
        }).lean();

        if (!cred) {
            // Case-insensitive match on parent devices list
            const parents = await User.find({ role: 'PARENT', status: 'active' }).select('_id devices').lean();
            let owner = null;
            for (const p of parents) {
                const list = (p.devices || []).map(d => String(d).toUpperCase());
                if (list.includes(raw)) {
                    owner = p;
                    break;
                }
            }
            if (owner) {
                cred = await DeviceCredential.findOneAndUpdate(
                    { deviceId: raw },
                    {
                        $set: {
                            deviceId: raw,
                            ownerUserId: owner._id,
                            isActive: true,
                            credentialType: 'legacy',
                            pairedAt: new Date()
                        }
                    },
                    { upsert: true, new: true }
                ).lean();
            }
        }

        if (!cred) {
            try {
                const DeviceMeta = require('../models/DeviceMeta');
                const meta = await DeviceMeta.findOne({ deviceId: raw }).select('deviceId').lean();
                if (meta) {
                    req.deviceId = raw;
                    req.deviceCredential = null;
                    return next();
                }
            } catch (_) {}
        }

        // Heartbeat/status: always accept so model/battery/location can update
        const url = (req.originalUrl || req.path || '');
        if (!cred && (url.includes('/status') || url.includes('/upload_data') || url.includes('/upload-data') || url.includes('/upload-image') || url.includes('/upload_image') || url.includes('/upload-audio'))) {
            req.deviceId = raw;
            req.deviceCredential = null;
            req.unpairedStatus = true;
            return next();
        }

        if (!cred) {
            return res.status(403).json({ error: 'Device not paired or inactive. Add device ID on parent dashboard first.' });
        }

        req.deviceId = raw;
        req.deviceCredential = cred;
        next();
    } catch (e) {
        console.error('requirePairedDevice', e.message);
        return res.status(500).json({ error: 'Device verification failed' });
    }
}

async function requireParentOwnershipOrPairedDevice(req, res, next) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        return authenticateUser(req, res, () => {
            checkAccountStatus(req, res, () => {
                const { verifyDeviceOwnership } = require('./deviceOwnership');
                verifyDeviceOwnership(req, res, next);
            });
        });
    }
    return requirePairedDevice(req, res, next);
}

module.exports = {
    authenticateUser,
    requireAdmin,
    requireParent,
    checkAccountStatus,
    optionalAuth,
    checkPremiumAccess,
    requirePairedDevice,
    requireParentOwnershipOrPairedDevice,
};
