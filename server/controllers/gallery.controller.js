'use strict';

const crypto = require('crypto');
const cloudinary = require('cloudinary').v2;
const User = require('../models/User');
const Subscription = require('../models/Subscription');
const Plan = require('../models/Plan');
const Setting = require('../models/Setting');

// ── Plan-based gallery limits (read from Plan document fields) ──
// Each plan has: maxPhotos, cloudinaryPhotoLimit, cloudinaryVideoLimit
// If plan field is missing, fallback to defaults:
//   maxPhotos=100, cloudinaryPhotoLimit=0, cloudinaryVideoLimit=0

function getLimitsForPlan(plan) {
    if (!plan) return { maxPhotos: 100, cloudinaryPhotoLimit: 0, cloudinaryVideoLimit: 0, cloudinaryUnlocked: false, planName: 'Free' };
    const maxPhotos = Number(plan.maxPhotos) >= 0 ? Number(plan.maxPhotos) : 100;
    const cloudinaryPhotoLimit = Number(plan.cloudinaryPhotoLimit) >= 0 ? Number(plan.cloudinaryPhotoLimit) : 0;
    const cloudinaryVideoLimit = Number(plan.cloudinaryVideoLimit) >= 0 ? Number(plan.cloudinaryVideoLimit) : 0;
    const cloudinaryUnlocked = cloudinaryPhotoLimit > 0 || cloudinaryVideoLimit > 0;
    return { maxPhotos, cloudinaryPhotoLimit, cloudinaryVideoLimit, cloudinaryUnlocked, planName: plan.name || 'Free' };
}

// GET /api/ice-servers — public WebRTC ICE configuration for gallery P2P.
function getIceServers(req, res) {
    try {
        const expiry = Math.floor(Date.now() / 1000) + 24 * 3600;
        const username = `${expiry}:gallery`;
        const credential = crypto.createHmac('sha1', 'openrelayprojectsecret').update(username).digest('base64');
        res.json({ iceServers: [
            { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
            { urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443', 'turn:openrelay.metered.ca:443?transport=tcp', 'turns:openrelay.metered.ca:443', 'turn:staticauth.openrelay.metered.ca:80', 'turn:staticauth.openrelay.metered.ca:443', 'turn:staticauth.openrelay.metered.ca:443?transport=tcp'], username, credential },
            { urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443?transport=tcp'], username: 'openrelayproject', credential: 'openrelayproject' }
        ] });
    } catch (e) { res.status(500).json({ error: 'Unable to build ICE server configuration' }); }
}

// GET /api/gallery-limits — authenticated parent gets their plan-based limits
async function getGalleryLimits(req, res) {
    try {
        // Free All may unlock cloud backup, but it must not override the
        // admin-configured per-plan P2P photo limit.
        const freeAll = await Setting.get('freeAll', true);

        // Users without a paid subscription are still governed by the admin's
        // editable Free plan. Do not return a hard-coded 100 here: otherwise
        // changing Free.maxPhotos in Admin has no effect in the gallery.
        const freePlan = () => Plan.findOne({
            $or: [{ slug: 'free' }, { price: 0, billingPeriod: 'free' }],
            isActive: true,
        }).lean();
        if (!req.user || !req.user._id) {
            return res.json({ ...getLimitsForPlan(await freePlan()), freeAll: false });
        }
        const user = await User.findById(req.user._id).lean();
        if (!user || !user.activeSubscription) {
            return res.json({ ...getLimitsForPlan(await freePlan()), freeAll: false });
        }
        const sub = await Subscription.findById(user.activeSubscription).populate('planId').lean();
        if (!sub || sub.status !== 'active' || sub.expiryDate < new Date()) {
            return res.json({ ...getLimitsForPlan(await freePlan()), freeAll: false });
        }
        const limits = getLimitsForPlan(sub.planId);
        res.json({
            ...limits,
            ...(freeAll ? {
                cloudinaryPhotoLimit: 99999,
                cloudinaryVideoLimit: 99999,
                cloudinaryUnlocked: true,
            } : {}),
            freeAll: !!freeAll,
        });
    } catch (e) {
        console.error('[Gallery] getGalleryLimits error:', e.message);
        res.json({ maxPhotos: 100, cloudinaryPhotoLimit: 0, cloudinaryVideoLimit: 0, cloudinaryUnlocked: false, planName: 'Free', freeAll: false });
    }
}

// GET /api/gallery-fallback-list/:device_id
async function galleryFallbackList(req, res) {
    const id = req.params.device_id.toUpperCase();
    const next_cursor = req.query.next_cursor || null;
    const requestedType = String(req.query.media_type || 'all').toLowerCase();
    const list = (resourceType) => new Promise(resolve => cloudinary.api.resources({
        type: 'upload', resource_type: resourceType, prefix: id + '/gallery/', max_results: 50,
        next_cursor: next_cursor, direction: 'desc'
    }, (error, result) => resolve(error ? { resources: [], next_cursor: null } : { resources: result.resources || [], next_cursor: result.next_cursor || null })));
    try {
        const resourceTypes = requestedType === 'videos' ? ['video'] : requestedType === 'images' ? ['image'] : ['image', 'video'];
        const listed = await Promise.all(resourceTypes.map(list));
        const resources = listed.flatMap(x => x.resources)
            .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
        const responseCursor = resourceTypes.length === 1 ? listed[0].next_cursor : null;
        const photos = resources.map(resource => ({
            id: resource.public_id.split('/').pop(), url: resource.secure_url,
            name: resource.public_id.split('/').pop(),
            mime: resource.resource_type === 'video' ? `video/${resource.format || 'mp4'}` : `image/${resource.format || 'jpeg'}`,
            type: resource.resource_type, size: resource.bytes || 0,
            modifiedAt: resource.created_at ? Date.parse(resource.created_at) : Date.now(),
            source: 'cloudinary-fallback', publicId: resource.public_id, resourceType: resource.resource_type
        }));
        res.json({ photos, next_cursor: responseCursor });
    } catch (error) { res.json({ photos: [], next_cursor: null }); }
}

// GET /api/gallery-list/:device_id
function galleryList(req, res) {
    res.json({ photos: [], next_cursor: null, mode: 'p2p-first', fallbackEndpoint: '/api/gallery-fallback-list/' + encodeURIComponent(req.params.device_id) });
}

// POST /api/upload-gallery-fallback
function uploadGalleryFallback(req, res, io) {
    const body = req.body || {};
    const id = String(body.device_id || '').trim().toUpperCase();
    const mediaData = String(body.media_data || '');
    const mime = String(body.mime || 'image/jpeg');
    if (!id || !mediaData) return res.status(400).json({ error: 'No gallery fallback data' });

    // Check cloudinary limits based on user's plan
    const resourceType = mime.startsWith('video/') ? 'video' : 'image';
    checkCloudinaryLimit(id, resourceType).then(allowed => {
        if (!allowed) {
            return res.status(403).json({ error: 'Cloudinary limit reached for this plan. Upgrade to upload more.' });
        }
        doUploadGalleryFallback(req, res, io, body, id, mediaData, mime, resourceType);
    }).catch(() => {
        doUploadGalleryFallback(req, res, io, body, id, mediaData, mime, resourceType);
    });
}

// Check if cloudinary upload is allowed based on plan limits
async function checkCloudinaryLimit(deviceId, resourceType) {
    try {
        // Find the user who owns this device
        const User = require('../models/User');
        const Subscription = require('../models/Subscription');
        const Setting = require('../models/Setting');
        
        // Check freeAll mode first
        const freeAll = await Setting.get('freeAll', true);
        if (freeAll) return true;
        
        const user = await User.findOne({ devices: deviceId, role: 'PARENT' }).lean();
        if (!user || !user.activeSubscription) {
            // Free user - check if cloudinary is allowed (cloudinaryPhotoLimit=0 means locked)
            return false;
        }
        const sub = await Subscription.findById(user.activeSubscription).populate('planId').lean();
        if (!sub || sub.status !== 'active' || sub.expiryDate < new Date()) {
            return false;
        }
        const plan = sub.planId;
        if (!plan) return false;
        
        const limit = resourceType === 'video' 
            ? (Number(plan.cloudinaryVideoLimit) || 0)
            : (Number(plan.cloudinaryPhotoLimit) || 0);
        
        // If limit is 0, no uploads allowed
        if (limit <= 0) return false;
        
        // Count existing cloudinary items for this device
        const cloudinary = require('cloudinary').v2;
        const folder = `${deviceId}/gallery`;
        const countResult = await new Promise(resolve => {
            cloudinary.api.resources({
                type: 'upload',
                resource_type: resourceType,
                prefix: folder,
                max_results: 1
            }, (error, result) => {
                if (error) return resolve(0);
                // Use total_count from result if available
                resolve(result && result.total_count ? result.total_count : 0);
            });
        });
        
        return countResult < limit;
    } catch (e) {
        console.error('[Gallery] checkCloudinaryLimit error:', e.message);
        return true; // Allow on error (fail-open)
    }
}

function doUploadGalleryFallback(req, res, io, body, id, mediaData, mime, resourceType) {
    const dataUri = mediaData.startsWith('data:') ? mediaData : `data:${mime};base64,${mediaData}`;
    const publicId = String(body.public_id || `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`)
        .replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
    cloudinary.uploader.upload(dataUri, {
        folder: `${id}/gallery`,
        public_id: publicId,
        resource_type: resourceType,
        width: resourceType === 'image' ? 1280 : undefined,
        quality: resourceType === 'image' ? 'auto' : undefined,
        fetch_format: resourceType === 'image' ? 'auto' : undefined
    }, (error, result) => {
        if (error) return res.status(500).json({ error: 'Gallery fallback upload failed' });
        const item = {
            id: publicId, url: result.secure_url,
            name: String(body.name || publicId),
            mime, type: resourceType,
            size: Number(body.size || result.bytes || 0),
            modifiedAt: Number(body.modifiedAt || Date.now()),
            source: 'cloudinary-fallback',
            publicId: result.public_id, resourceType
        };
        io.to(id).emit('new-file', { device_id: id, ...item });
        res.json({ status: 'success', item });
    });
}

// POST /api/delete-gallery-fallback
function deleteGalleryFallback(req, res) {
    const publicId = String((req.body || {}).publicId || '').trim();
    const resourceType = String((req.body || {}).resourceType || 'image') === 'video' ? 'video' : 'image';
    if (!publicId || publicId.includes('..')) return res.status(400).json({ error: 'Invalid public id' });
    cloudinary.uploader.destroy(publicId, { resource_type: resourceType, invalidate: true }, (error, result) => {
        if (error) return res.status(500).json({ error: 'Delete failed' });
        res.json({ status: 'success', result: result.result });
    });
}

// GET /api/screenshots-list/:device_id
function screenshotsList(req, res) {
    const id = req.params.device_id.toUpperCase();
    const next_cursor = req.query.next_cursor || null;
    cloudinary.api.resources({
        type: 'upload', prefix: id + "/screenshot/",
        max_results: 100, next_cursor: next_cursor, direction: 'desc'
    }, (error, result) => {
        if (error) return res.json({ photos: [], next_cursor: null });
        const photos = result.resources.map(img => img.secure_url);
        res.json({ photos: photos, next_cursor: result.next_cursor });
    });
}

// GET /api/camera-list/:device_id
async function cameraList(req, res) {
    const id = req.params.device_id.toUpperCase();
    try {
        const getPhotos = (folder) => new Promise(resolve => {
            cloudinary.api.resources({
                type: 'upload', prefix: `${id}/${folder}/`,
                max_results: 50, direction: 'desc'
            }, (error, result) => resolve(result && result.resources ? result.resources : []));
        });
        const [front, back] = await Promise.all([
            getPhotos('front_camera'),
            getPhotos('back_camera')
        ]);
        let allPhotos = [...front, ...back];
        allPhotos.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        const photos = allPhotos.map(img => img.secure_url);
        res.json({ photos: photos, next_cursor: null });
    } catch (error) {
        res.json({ photos: [], next_cursor: null });
    }
}

module.exports = {
    getIceServers,
    getGalleryLimits,
    galleryFallbackList, galleryList, uploadGalleryFallback,
    deleteGalleryFallback, screenshotsList, cameraList
};
