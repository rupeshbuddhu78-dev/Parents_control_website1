'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const compression = require('compression');
const bodyParser = require('body-parser');
const helmet = require('helmet');
const constants = require('./config/constants');
const requestLogger = require('./middleware/requestLogger');
const errorHandler = require('./middleware/errorHandler');
const { apiLimiter } = require('./middleware/rateLimiter');

function createApp(io) {
    const app = express();

    // ─── Trust Proxy (Required for Render/Heroku/Cloudflare) ────
    app.set('trust proxy', 1);

    // Ensure uploads directory exists
    const UPLOADS_DIR = path.join(__dirname, 'uploads');
    if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

    // ─── Security Headers ────────────────────────────────────────
    app.use(helmet({
        contentSecurityPolicy: false, // SPA + inline scripts on parent pages
        crossOriginEmbedderPolicy: false,
        referrerPolicy: { policy: 'no-referrer' },
        frameguard: { action: 'sameorigin' },
        hidePoweredBy: true,
        noSniff: true,
        xssFilter: true,
    }));
    app.disable('x-powered-by');

    // ─── CORS (set CORS_ORIGINS in production to your real domain) ─
    const allowedOrigins = process.env.CORS_ORIGINS
        ? process.env.CORS_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
        : [];

    app.use(cors({
        origin: (origin, callback) => {
            // No Origin (mobile apps / same-origin) allowed
            if (!origin) return callback(null, true);
            if (allowedOrigins.length === 0) return callback(null, true); // legacy open until env set
            if (allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
                return callback(null, true);
            }
            return callback(new Error('Not allowed by CORS'));
        },
        credentials: true,
    }));

    // ─── Compression & Logging ───────────────────────────────────
    app.use(compression());
    app.use(requestLogger);

    // ─── Rate Limiting (general) ─────────────────────────────────
    app.use('/api/', apiLimiter);

    // Static uploads directory — PDFs must be embeddable on this same site
    app.use('/uploads', function (req, res, next) {
        res.setHeader('X-Frame-Options', 'SAMEORIGIN');
        res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
        next();
    }, express.static(UPLOADS_DIR, {
        setHeaders: function (res, filePath) {
            const lower = String(filePath || '').toLowerCase();
            if (lower.endsWith('.pdf')) res.setHeader('Content-Type', 'application/pdf');
            if (lower.endsWith('.mp4')) res.setHeader('Content-Type', 'video/mp4');
            if (lower.endsWith('.webm')) res.setHeader('Content-Type', 'video/webm');
        }
    }));

    // ─── Raw Binary Upload Routes (MUST be before JSON body parser) ───
    const uploadCtrl = require('./controllers/upload.controller');
    const { requirePairedDevice } = require('./middleware/auth');
    const { deviceApiLimiter } = require('./middleware/rateLimiter');
    app.post('/api/upload-storage-file', deviceApiLimiter, requirePairedDevice, express.raw({ type: '*/*', limit: '300mb' }), uploadCtrl.uploadStorageFile);
    app.post('/api/upload-storage-chunk', deviceApiLimiter, requirePairedDevice, express.raw({ type: '*/*', limit: '8mb' }), uploadCtrl.uploadStorageChunk);

    // ─── Body Parsers ────────────────────────────────────────────
    app.use(bodyParser.json({
        limit: constants.MAX_BODY_SIZE,
        verify: (req, res, buffer) => {
            if (req.originalUrl === '/api/payment/webhook/cashfree') {
                req.rawBody = Buffer.from(buffer);
            }
        },
    }));
    app.use(bodyParser.urlencoded({ limit: constants.MAX_BODY_SIZE, extended: true }));

    // ─── API Routes (before static / catch-all) ───────────────────
    if (io) {
        try {
            require('./routes')(app, io);
        } catch (e) {
            console.error('Failed to mount API routes:', e.message);
        }
    }

    // ─── Root Route - Serve Public Landing Page ──────────────────
    app.get('/', (req, res) => {
        res.sendFile(path.join(__dirname, '..', 'parent', 'public.html'));
    });

    const PUBLIC_PATHS = new Set([
        '/', '/public.html', '/login.html', '/plans.html', '/payment-verify.html',
        '/login', '/plans', '/payment-verify', '/favicon.ico'
    ]);
    function looksLikePage(p) {
        if (!p || p.startsWith('/api/')) return false;
        if (/\.(js|css|png|jpe?g|webp|gif|svg|ico|woff2?|ttf|map|mp4|webm)$/i.test(p)) return false;
        return p.endsWith('.html') || !p.includes('.');
    }
    function readCookie(req, name) {
        const raw = String(req.headers.cookie || '');
        const m = raw.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
        return m ? decodeURIComponent(m[1]) : '';
    }
    app.use((req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        const p = req.path || '/';
        if (!looksLikePage(p) || PUBLIC_PATHS.has(p)) return next();
        const authed = readCookie(req, 'pc_auth') === '1';
        if (!authed) {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            return res.end('<!DOCTYPE html><html><head><meta charset="utf-8"><title>Login</title></head><body><script>(function(){try{var t=localStorage.getItem("access_token");var u=JSON.parse(localStorage.getItem("user")||"{}");if(t){document.cookie="pc_auth=1;path=/;max-age=2592000;SameSite=Lax";if(u&&u.role)document.cookie="pc_role="+encodeURIComponent(u.role)+";path=/;max-age=2592000;SameSite=Lax";location.reload();return;}}catch(e){}location.replace("/login.html?next="+encodeURIComponent(location.pathname+location.search));})();</script></body></html>');
        }
        if (/admin|rupesh/i.test(p) && readCookie(req, 'pc_role') !== 'ADMIN') {
            return res.redirect('/dashboard.html');
        }
        next();
    });

    // Serve frontend HTML files from parent directory
    app.use(express.static(path.join(__dirname, '..', 'parent')));
    app.use(express.static(__dirname));

    // ─── Google OAuth Callback ──────────────────────────────────
    app.get('/auth/google/callback', (req, res) => {
        res.sendFile(path.join(__dirname, '..', 'parent', 'login.html'));
    });

    // ─── Clean URLs (without .html extension) ───────────────────
    app.get('*', (req, res, next) => {
        if (req.path.startsWith('/api/') || req.path.includes('.')) {
            return next();
        }
        const htmlPath = path.join(__dirname, '..', 'parent', req.path + '.html');
        if (fs.existsSync(htmlPath)) {
            return res.sendFile(htmlPath);
        }
        next();
    });

    // Centralized error handler (must be last)
    app.use(errorHandler);

    return app;
}

module.exports = createApp;
