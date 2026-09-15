'use strict';

const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/boot.controller');
const { authenticateUser, checkAccountStatus, requirePairedDevice } = require('../middleware/auth');
const { verifyDeviceOwnership } = require('../middleware/deviceOwnership');
const { deviceApiLimiter } = require('../middleware/rateLimiter');

module.exports = function (io) {
    // Child reports boot — paired only
    router.post('/boot-status', deviceApiLimiter, requirePairedDevice, (req, res) => ctrl.postBootStatus(req, res, io));
    // Parent reads
    router.get('/boot-events/:deviceId', authenticateUser, checkAccountStatus, verifyDeviceOwnership, ctrl.getBootEvents);
    router.get('/boot-status/:deviceId', authenticateUser, checkAccountStatus, verifyDeviceOwnership, ctrl.getBootStatus);
    return router;
};
