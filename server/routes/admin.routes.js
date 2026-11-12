'use strict';

const express = require('express');
const router = express.Router();
const multer = require('multer');
const ctrl = require('../controllers/admin.controller');
const { authenticateUser, requireAdmin, checkAccountStatus } = require('../middleware/auth');

// Configure multer for video and image uploads
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 300 * 1024 * 1024 }, // 300MB max
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('video/') || file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only video and image files are allowed'));
        }
    }
});

// Disk-based multer for large video uploads (avoids loading 300MB into RAM)
const path = require('path');
const os = require('os');
const uploadDisk = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, os.tmpdir()),
        filename: (req, file, cb) => cb(null, 'admin_video_' + Date.now() + '_' + Math.random().toString(36).slice(2) + path.extname(file.originalname))
    }),
    limits: { fileSize: 300 * 1024 * 1024 }, // 300MB max
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
router.delete('/admin/devices/:id', ctrl.deleteDeviceFully);
router.post('/admin/devices/:id/delete', ctrl.deleteDeviceFully);
router.get('/admin/audit-logs', ctrl.getAuditLogs);
router.get('/admin/subscriptions', ctrl.getSubscriptions);
router.get('/admin/payments', ctrl.getPayments);

// Video management
router.get('/admin/videos', ctrl.getVideos);
router.post('/admin/videos', uploadDisk.single('video'), ctrl.uploadVideo);
router.post('/admin/videos/:videoId/thumbnail', upload.single('thumbnail'), ctrl.uploadVideoThumbnail);
router.delete('/admin/videos/:id', ctrl.deleteVideo);

// Admin settings
router.put('/admin/settings/name', ctrl.changeAdminName);
router.put('/admin/settings/password', ctrl.changeAdminPassword);
router.get('/admin/settings/apk-url', ctrl.getApkUrl);
router.put('/admin/settings/apk-url', ctrl.setApkUrl);

// Individual Feature Lock/Unlock
router.get('/admin/settings/features', ctrl.getFeatureLocks);
router.post('/admin/settings/features/:featureKey', ctrl.setFeatureLock);
router.post('/admin/settings/features-lock-all', ctrl.lockAllFeatures);

// Website Content Management
const contentCtrl = require('../controllers/content.controller');
router.get('/admin/site-content', contentCtrl.getSiteContent);
router.put('/admin/site-content', contentCtrl.saveSiteContent);
router.patch('/admin/site-content/item', contentCtrl.updateSingleItem);
router.delete('/admin/site-content/item', contentCtrl.deleteSingleItem);
router.post('/admin/site-content/add-item', contentCtrl.addNewItem);

module.exports = router;
