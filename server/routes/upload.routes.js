'use strict';

const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/upload.controller');

module.exports = function (io) {
    // Binary gallery fallback upload
    router.post('/upload-gallery-fallback-binary', express.raw({ type: '*/*', limit: '50mb' }), (req, res) => {
        ctrl.uploadGalleryFallbackBinary(req, res, io);
    });

    // Image / audio – support both hyphen and underscore (Android app variants)
    router.post(['/upload-image', '/upload_image'], (req, res) => ctrl.uploadImage(req, res, io));
    router.post(['/upload-audio', '/upload_audio'], (req, res) => ctrl.uploadAudio(req, res, io));
    router.get(['/audio-history/:device_id', '/audio_history/:device_id'], ctrl.audioHistory);

    // Main data upload – Android uses /api/upload_data (underscore)
    router.post(['/upload-data', '/upload_data'], (req, res) => ctrl.uploadData(req, res, io));

    router.get(['/get-data/:device_id/:type', '/get_data/:device_id/:type'], ctrl.getData);
    router.get(['/folder-list/:device_id', '/folder_list/:device_id'], ctrl.folderList);

    return router;
};
