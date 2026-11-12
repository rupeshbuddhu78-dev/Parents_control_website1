'use strict';

const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/command.controller');
const { authenticateUser, checkAccountStatus } = require('../middleware/auth');
const { verifyDeviceOwnership } = require('../middleware/deviceOwnership');
const { apiLimiter } = require('../middleware/rateLimiter');

module.exports = function (io) {
    // Parent-only: JWT + device ownership required
    router.post(
        '/send-command',
        apiLimiter,
        authenticateUser,
        checkAccountStatus,
        verifyDeviceOwnership,
        (req, res) => ctrl.sendCommand(req, res, io)
    );
    return router;
};
