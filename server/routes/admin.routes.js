'use strict';

const express = require('express');
const router = express.Router();
const multer = require('multer');
const ctrl = require('../controllers/admin.controller');
const { authenticateUser, requireAdmin, checkAccountStatus } = require('../middleware/auth');

// Configure multer for video uploads
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 100 * 1024 * 1024 }, // 100MB max
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('video/')) {
            cb(null, true);
        } else {
            cb(new Error('Only video files are allowed'));
        }
    }
});

// Admin routes - middleware scoped to /admin/* paths only
// This prevents requireAdmin from blocking non-admin routes like /api/parent/*
router.use('/admin', authenticateUser, requireAdmin, checkAccountStatus);

router.get('/admin/dashboard', ctrl.getDashboard);
router.get('/admin/parents', ctrl.getParents);
router.get('/admin/parents/:id', ctrl.getParentDetail);
router.post('/admin/parents/:id/suspend', ctrl.suspendParent);
router.post('/admin/parents/:id/unsuspend', ctrl.unsuspendParent);
router.post('/admin/parents/:id/force-logout', ctrl.forceLogout);
router.post('/admin/parents/:id/disable', ctrl.disableParent);
router.post('/admin/parents/:id/enable', ctrl.enableParent);
router.get('/admin/devices-managed', ctrl.getAllDevices);
router.get('/admin/devices/:id', ctrl.getDeviceDetail);
router.get('/admin/audit-logs', ctrl.getAuditLogs);
router.get('/admin/subscriptions', ctrl.getSubscriptions);
router.get('/admin/payments', ctrl.getPayments);

// Video management
router.get('/admin/videos', ctrl.getVideos);
router.post('/admin/videos', upload.single('video'), ctrl.uploadVideo);
router.delete('/admin/videos/:id', ctrl.deleteVideo);

// Admin settings
router.put('/admin/settings/name', ctrl.changeAdminName);
router.put('/admin/settings/password', ctrl.changeAdminPassword);

module.exports = router;
