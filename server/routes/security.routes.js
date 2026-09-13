'use strict';

const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/security.controller');
const { authenticateUser, checkAccountStatus } = require('../middleware/auth');
const { verifyDeviceOwnership } = require('../middleware/deviceOwnership');
const { apiLimiter } = require('../middleware/rateLimiter');

module.exports = function (io) {
    const parentDevice = [apiLimiter, authenticateUser, checkAccountStatus, verifyDeviceOwnership];

    router.post('/clear-data', ...parentDevice, (req, res) => ctrl.clearData(req, res, io));
    router.get('/activity-events', authenticateUser, checkAccountStatus, verifyDeviceOwnership, ctrl.getActivityEvents);
    router.post('/wipe-device', ...parentDevice, (req, res) => ctrl.wipeDevice(req, res, io));
    router.post('/set-pin', ...parentDevice, (req, res) => ctrl.setPin(req, res, io));
    return router;
};
