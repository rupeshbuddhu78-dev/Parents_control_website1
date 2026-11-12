'use strict';

/**
 * Seed admin user from env:
 *   ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME
 *
 * Usage: node server/scripts/seedAdmin.js
 */
const path = require('path');
// Load .env if present (optional)
try { require('dotenv').config({ path: path.join(__dirname, '../../.env') }); } catch (e) { /* dotenv optional */ }

const env = require('../config/env');
const { connect, mongoose } = require('../config/db');
const User = require('../models/User');

async function seed() {
    const email = (env.ADMIN_EMAIL || process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    const password = env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || '';
    const name = env.ADMIN_NAME || process.env.ADMIN_NAME || 'Admin';

    if (!email || !password) {
        console.log('[seedAdmin] ADMIN_EMAIL / ADMIN_PASSWORD not set — skipping admin seed.');
        process.exit(0);
    }

    if (password.length < 8) {
        console.error('[seedAdmin] ADMIN_PASSWORD must be at least 8 characters.');
        process.exit(1);
    }

    const ok = await connect();
    if (!ok) {
        console.error('[seedAdmin] MongoDB connection failed.');
        process.exit(1);
    }

    try {
        let user = await User.findOne({ email });
        if (user) {
            // Ensure role is ADMIN
            if (user.role !== 'ADMIN') {
                user.role = 'ADMIN';
                user.status = 'active';
                await user.save();
                console.log('[seedAdmin] Existing user upgraded to ADMIN:', email);
            } else {
                console.log('[seedAdmin] Admin already exists:', email);
            }
        } else {
            user = new User({
                email,
                name,
                password, // pre-save hook hashes it
                role: 'ADMIN',
                status: 'active',
                emailVerified: true,
            });
            await user.save();
            console.log('[seedAdmin] Admin created:', email);
        }
    } catch (err) {
        console.error('[seedAdmin] Error:', err.message);
        process.exit(1);
    } finally {
        await mongoose.disconnect().catch(() => {});
    }
}

seed();
