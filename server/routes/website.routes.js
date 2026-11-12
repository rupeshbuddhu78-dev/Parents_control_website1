'use strict';

const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/website.controller');

module.exports = function (io) {
    router.get('/websites/:device_id', ctrl.getWebsites);
    router.get('/blocked-websites/:device_id', ctrl.getBlockedWebsites);
    router.post('/blocked-websites', (req, res) => ctrl.postBlockedWebsites(req, res, io));
    router.post('/whitelist-websites', (req, res) => ctrl.postWhitelistWebsites(req, res, io));
    router.get('/whitelist-websites/:device_id', ctrl.getWhitelistWebsites);
    return router;
};
