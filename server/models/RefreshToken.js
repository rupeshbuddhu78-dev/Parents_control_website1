'use strict';

const { mongoose } = require('../config/db');
const crypto = require('crypto');

const RefreshTokenSchema = new mongoose.Schema({
    token: { type: String, required: true, unique: true, index: true },
    // Hash of token – some older deployments had unique index on tokenHash
    tokenHash: { type: String, required: true, unique: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    familyId: { type: String, required: true, index: true },
    isRevoked: { type: Boolean, default: false },
    expiresAt: { type: Date, required: true, index: true },
    createdAt: { type: Date, default: Date.now },
    userAgent: { type: String, default: '' },
    ip: { type: String, default: '' },
}, { collection: 'refresh_tokens' });

RefreshTokenSchema.statics.generateToken = function () {
    return crypto.randomBytes(40).toString('hex');
};

RefreshTokenSchema.statics.hashToken = function (token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
};

// TTL cleanup
RefreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const RefreshToken = mongoose.models.RefreshToken || mongoose.model('RefreshToken', RefreshTokenSchema);

/**
 * One-time repair for legacy unique index on tokenHash with null values.
 * Call after MongoDB connect.
 */
async function repairRefreshTokenIndexes() {
    try {
        const col = mongoose.connection.collection('refresh_tokens');

        // Remove broken docs that have null/missing tokenHash (cause E11000)
        const del = await col.deleteMany({
            $or: [
                { tokenHash: null },
                { tokenHash: { $exists: false } },
                { token: null },
                { token: { $exists: false } },
            ],
        });
        if (del.deletedCount) {
            console.log('[RefreshToken] cleaned broken docs:', del.deletedCount);
        }

        // Ensure indexes match schema (drop legacy bad ones if needed)
        const indexes = await col.indexes();
        for (const idx of indexes) {
            // Old unique index on tokenHash that allowed issues
            if (idx.name === 'tokenHash_1' && idx.unique) {
                // recreate via syncIndexes later
            }
        }

        await RefreshToken.syncIndexes();
        console.log('[RefreshToken] indexes synced');
    } catch (e) {
        console.warn('[RefreshToken] repair skipped:', e.message);
    }
}

module.exports = RefreshToken;
module.exports.repairRefreshTokenIndexes = repairRefreshTokenIndexes;
