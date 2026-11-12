'use strict';

const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/upload.controller');
const { authenticateUser, checkAccountStatus, requirePairedDevice } = require('../middleware/auth');
const { verifyDeviceOwnership } = require('../middleware/deviceOwnership');
const { deviceApiLimiter } = require('../middleware/rateLimiter');

module.exports = function (io) {
    // Child binary uploads — must be paired
    router.post('/upload-gallery-fallback-binary', deviceApiLimiter, requirePairedDevice, express.raw({ type: '*/*', limit: '300mb' }), (req, res) => {
        ctrl.uploadGalleryFallbackBinary(req, res, io);
    });

    router.post(['/upload-image', '/upload_image'], deviceApiLimiter, requirePairedDevice, (req, res) => ctrl.uploadImage(req, res, io));
    router.post(['/upload-audio', '/upload_audio'], deviceApiLimiter, requirePairedDevice, (req, res) => ctrl.uploadAudio(req, res, io));
    router.post(['/upload-data', '/upload_data'], deviceApiLimiter, requirePairedDevice, (req, res) => ctrl.uploadData(req, res, io));

    // Parent reads
    router.get(['/audio-history/:device_id', '/audio_history/:device_id'], authenticateUser, checkAccountStatus, verifyDeviceOwnership, ctrl.audioHistory);
    router.get(['/get-data/:device_id/:type', '/get_data/:device_id/:type'], authenticateUser, checkAccountStatus, verifyDeviceOwnership, ctrl.getData);
    router.get(['/folder-list/:device_id/:folder', '/folder_list/:device_id/:folder', '/folder-list/:device_id', '/folder_list/:device_id'], authenticateUser, checkAccountStatus, verifyDeviceOwnership, ctrl.folderList);

    return router;
};
