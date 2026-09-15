'use strict';

const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/gallery.controller');
const { authenticateUser, checkAccountStatus, requirePairedDevice } = require('../middleware/auth');
const { verifyDeviceOwnership } = require('../middleware/deviceOwnership');
const { deviceApiLimiter } = require('../middleware/rateLimiter');

module.exports = function (io) {
    // Public ICE servers for WebRTC (no secrets beyond STUN/TURN config)
    router.get('/ice-servers', ctrl.getIceServers);

    router.get('/gallery-limits', authenticateUser, checkAccountStatus, ctrl.getGalleryLimits);

    // Parent reads — JWT + ownership
    router.get('/gallery-fallback-list/:device_id', authenticateUser, checkAccountStatus, verifyDeviceOwnership, ctrl.galleryFallbackList);
    router.get('/gallery-list/:device_id', authenticateUser, checkAccountStatus, verifyDeviceOwnership, ctrl.galleryList);
    router.get('/screenshots-list/:device_id', authenticateUser, checkAccountStatus, verifyDeviceOwnership, ctrl.screenshotsList);
    router.get('/camera-list/:device_id', authenticateUser, checkAccountStatus, verifyDeviceOwnership, ctrl.cameraList);

    // Child upload fallback — paired device
    router.post('/upload-gallery-fallback', deviceApiLimiter, requirePairedDevice, (req, res) => ctrl.uploadGalleryFallback(req, res, io));

    // Parent delete cloud item
    router.post('/delete-gallery-fallback', authenticateUser, checkAccountStatus, verifyDeviceOwnership, ctrl.deleteGalleryFallback);
    return router;
};
