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
        contentSecurityPolicy: false,
        crossOriginEmbedderPolicy: false,
    }));

    // ─── CORS ────────────────────────────────────────────────────
    const allowedOrigins = process.env.CORS_ORIGINS
        ? process.env.CORS_ORIGINS.split(',').map(s => s.trim())
        : ['*'];

    app.use(cors({
        origin: allowedOrigins.includes('*') ? true : (origin, callback) => {
            if (!origin || allowedOrigins.includes(origin)) {
                callback(null, true);
            } else {
                callback(new Error('Not allowed by CORS'));
            }
        },
        credentials: true,
    }));

    // ─── Compression & Logging ───────────────────────────────────
    app.use(compression());
    app.use(requestLogger);

    // ─── Rate Limiting (general) ─────────────────────────────────
    app.use('/api/', apiLimiter);

    // Static uploads directory
    app.use('/uploads', express.static(UPLOADS_DIR));

    // ─── Raw Binary Upload Routes (MUST be before JSON body parser) ───
    const uploadCtrl = require('./controllers/upload.controller');
    app.post('/api/upload-storage-file', express.raw({ type: '*/*', limit: '120mb' }), uploadCtrl.uploadStorageFile);

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
