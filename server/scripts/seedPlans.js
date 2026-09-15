'use strict';

/**
 * Seed subscription plans from config/defaultPlans.js
 *
 * Usage: node server/scripts/seedPlans.js
 */
const path = require('path');
try { require('dotenv').config({ path: path.join(__dirname, '../../.env') }); } catch (e) { /* optional */ }

const { connect, mongoose } = require('../config/db');
const Plan = require('../models/Plan');
const defaultPlans = require('../config/defaultPlans');

async function seed() {
    const ok = await connect();
    if (!ok) {
        console.error('[seedPlans] MongoDB connection failed.');
        process.exit(1);
    }

    try {
        for (const p of defaultPlans) {
            const existing = await Plan.findOne({ slug: p.slug });
            if (existing) {
                // Update mutable fields, keep _id
                existing.name = p.name;
                existing.price = p.price;
                existing.currency = p.currency;
                existing.billingPeriod = p.billingPeriod;
                existing.durationDays = p.durationDays;
                existing.deviceLimit = p.deviceLimit;
                existing.features = p.features;
                existing.description = p.description;
                existing.isActive = p.isActive;
                existing.isPopular = p.isPopular;
                existing.sortOrder = p.sortOrder;
                existing.updatedAt = new Date();
                await existing.save();
                console.log('[seedPlans] Updated plan:', p.slug);
            } else {
                await Plan.create(p);
                console.log('[seedPlans] Created plan:', p.slug);
            }
        }
        console.log('[seedPlans] Done. Total plans:', defaultPlans.length);
    } catch (err) {
        console.error('[seedPlans] Error:', err.message);
        process.exit(1);
    } finally {
        await mongoose.disconnect().catch(() => {});
    }
}

seed();
