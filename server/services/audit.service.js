'use strict';

const AuditLog = require('../models/AuditLog');

async function logAction({ action, actorId, actorEmail, actorRole, targetId, targetType, details, ip, userAgent }) {
    try {
        await AuditLog.create({
            action: action || 'unknown',
            actorId: actorId || null,
            actorEmail: actorEmail || '',
            actorRole: actorRole || '',
            targetId: targetId != null ? String(targetId) : '',
            targetType: targetType || '',
            details: details || {},
            ip: ip || '',
            userAgent: userAgent || '',
            timestamp: new Date(),
        });
    } catch (e) {
        console.error('[audit] logAction failed', e.message);
    }
}

// Alias used by some controllers
async function log(opts) {
    return logAction(opts);
}

async function getAuditLogs({ page, limit, action, actorId } = {}) {
    const lim = Math.min(parseInt(limit, 10) || 50, 200);
    const pg = Math.max(parseInt(page, 10) || 1, 1);
    const q = {};
    if (action) q.action = action;
    if (actorId) q.actorId = actorId;

    const [items, total] = await Promise.all([
        AuditLog.find(q).sort({ timestamp: -1 }).skip((pg - 1) * lim).limit(lim).lean(),
        AuditLog.countDocuments(q),
    ]);

    return { items, total, page: pg, limit: lim, pages: Math.ceil(total / lim) };
}

module.exports = { logAction, log, getAuditLogs };
