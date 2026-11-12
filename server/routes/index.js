'use strict';

module.exports = function (app, io) {
    // Health check (do not override the public landing page at /)
    app.get('/api/health', (req, res) => {
        res.json({ ok: true, message: 'Server Running: WebRTC + Admin API Active' });
    });

    // Public videos endpoint (no auth required)
    app.get('/api/videos', async (req, res) => {
        try {
            const Video = require('../models/Video');
            const videos = await Video.find({}).sort({ createdAt: -1 });
            res.json({ videos });
        } catch (e) {
            res.json({ videos: [] });
        }
    });

    // Public APK download URL endpoint (no auth required)
    app.get('/api/settings/apk-url', async (req, res) => {
        try {
            const Setting = require('../models/Setting');
            const url = await Setting.get('apk_download_url', 'https://files.catbox.moe/9sve3e.apk');
            res.json({ url });
        } catch (e) {
            res.json({ url: 'https://files.catbox.moe/9sve3e.apk' });
        }
    });

    // Same-origin APK download: redirect to hosted file (fixes catbox/browser block on direct <a>)
    app.get('/api/download-apk', async (req, res) => {
        try {
            const Setting = require('../models/Setting');
            let url = await Setting.get('apk_download_url', 'https://files.catbox.moe/9sve3e.apk');
            if (!url || typeof url !== 'string' || !url.startsWith('http')) {
                url = 'https://files.catbox.moe/9sve3e.apk';
            }
            url = url.trim();
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('Referrer-Policy', 'no-referrer');
            return res.redirect(302, url);
        } catch (e) {
            return res.status(500).json({ error: 'APK download unavailable' });
        }
    });

    // Public site content endpoint (no auth required)
    const contentCtrl = require('../controllers/content.controller');
    app.get('/api/site-content', contentCtrl.getPublicSiteContent);

    // Auth routes (public + protected)
    app.use('/api', require('./auth.routes'));

    // Admin routes (protected)
    app.use('/api', require('./admin.routes'));

    // Subscription/Payment routes
    app.use('/api', require('./subscription.routes'));

    // Parent device management routes
    app.use('/api', require('./parent.routes'));

    // Mount remaining route groups under /api
    app.use('/api', require('./upload.routes')(io));
    app.use('/api', require('./device.routes')());
    app.use('/api', require('./command.routes')(io));
    app.use('/api', require('./chat.routes')());
    app.use('/api', require('./website.routes')(io));
    app.use('/api', require('./security.routes')(io));
    app.use('/api', require('./boot.routes')(io));
    app.use('/api', require('./gallery.routes')(io));
};
