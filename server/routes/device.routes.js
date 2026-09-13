'use strict';

const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/device.controller');
const { authenticateUser, requireAdmin, checkAccountStatus, requirePairedDevice } = require('../middleware/auth');
const { verifyDeviceOwnership } = require('../middleware/deviceOwnership');
const { deviceApiLimiter } = require('../middleware/rateLimiter');

module.exports = function () {
    // Admin only
    router.get('/admin/all-devices', authenticateUser, requireAdmin, ctrl.getAllDevices);

    // Parent read status of owned device
    router.get(
        '/device-status/:id',
        authenticateUser,
        checkAccountStatus,
        verifyDeviceOwnership,
        ctrl.getDeviceStatus
    );

    // Child heartbeat — paired device only (no parent JWT)
    router.post('/status', deviceApiLimiter, requirePairedDevice, ctrl.postStatus);
    return router;
};
