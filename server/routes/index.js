'use strict';

module.exports = function (app, io) {
    // Health check (do not override the public landing page at /)
    app.get('/api/health', (req, res) => {
        res.json({ ok: true, message: 'Server Running: WebRTC + Admin API Active' });
    });

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
