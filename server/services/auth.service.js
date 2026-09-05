'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const RefreshToken = require('../models/RefreshToken');
const env = require('../config/env');

function generateAccessToken(user) {
    return jwt.sign(
        {
            sub: String(user._id),
            email: user.email,
            role: user.role,
            status: user.status || 'active',
        },
        env.JWT_SECRET,
        { expiresIn: env.JWT_ACCESS_EXPIRY || '15m' }
    );
}

async function createRefreshToken(userId, meta) {
    const token = RefreshToken.generateToken();
    const tokenHash = RefreshToken.hashToken(token);
    const familyId = crypto.randomBytes(16).toString('hex');
    const days = env.JWT_REFRESH_EXPIRY_DAYS || 30;
    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    await RefreshToken.create({
        token,
        tokenHash,
        userId,
        familyId,
        expiresAt,
        userAgent: (meta && meta.userAgent) || '',
        ip: (meta && meta.ip) || '',
    });
    return token;
}

function publicUser(user) {
    return {
        _id: user._id,
        email: user.email,
        name: user.name,
        role: user.role,
        status: user.status,
        devices: user.devices || [],
        emailVerified: !!user.emailVerified,
        activeSubscription: user.activeSubscription || null,
    };
}

async function registerParent({ email, name, password, ip, userAgent }) {
    email = String(email || '').trim().toLowerCase();
    name = String(name || '').trim();
    if (!email || !password || password.length < 8) {
        throw new Error('Valid email and password (min 8 chars) required');
    }
    if (!name) name = email.split('@')[0];

    const existing = await User.findOne({ email });
    if (existing) throw new Error('Email already registered');

    const user = new User({
        email,
        name,
        password,
        role: 'PARENT',
        status: 'active',
        emailVerified: false,
    });
    await user.save();
    return publicUser(user);
}

async function loginUser({ email, password, ip, userAgent }) {
    email = String(email || '').trim().toLowerCase();
    if (!email || !password) throw new Error('Email and password required');

    const user = await User.findOne({ email });
    if (!user) throw new Error('Invalid credentials');
    if (user.status === 'banned') throw new Error('Account banned');
    if (user.status === 'suspended') throw new Error('Account suspended');

    const ok = await user.comparePassword(password);
    if (!ok) throw new Error('Invalid credentials');

    user.lastLogin = new Date();
    user.lastLoginIp = ip || '';
    await user.save();

    const accessToken = generateAccessToken(user);
    const refreshToken = await createRefreshToken(user._id, { ip, userAgent });

    return {
        accessToken,
        refreshToken,
        user: publicUser(user),
    };
}

async function refreshAccessToken({ refreshTokenValue, ip, userAgent }) {
    if (!refreshTokenValue) throw new Error('Refresh token required');

    const stored = await RefreshToken.findOne({ token: refreshTokenValue });
    if (!stored || stored.isRevoked) throw new Error('Invalid refresh token');
    if (stored.expiresAt < new Date()) throw new Error('Refresh token expired');

    const user = await User.findById(stored.userId);
    if (!user || user.status === 'banned' || user.status === 'suspended') {
        throw new Error('Account not active');
    }

    // Rotate: revoke old, issue new
    stored.isRevoked = true;
    await stored.save();

    const accessToken = generateAccessToken(user);
    const refreshToken = await createRefreshToken(user._id, { ip, userAgent });

    return { accessToken, refreshToken, user: publicUser(user) };
}

async function logoutUser({ refreshTokenValue, userId }) {
    if (refreshTokenValue) {
        await RefreshToken.updateOne({ token: refreshTokenValue }, { isRevoked: true });
    }
    if (userId) {
        await RefreshToken.updateMany({ userId, isRevoked: false }, { isRevoked: true });
    }
    return true;
}

async function forceLogoutUser(userId) {
    await RefreshToken.updateMany({ userId, isRevoked: false }, { isRevoked: true });
    return true;
}

async function requestPasswordReset({ email, ip }) {
    email = String(email || '').trim().toLowerCase();
    // Always return success to avoid email enumeration
    const generic = { success: true, message: 'If the email exists, a reset OTP has been sent.' };
    if (!email) return generic;

    const user = await User.findOne({ email });
    if (!user) return generic;

    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const hash = crypto.createHash('sha256').update(otp).digest('hex');
    user.passwordResetOtpHash = hash;
    user.passwordResetOtpExpires = new Date(Date.now() + 15 * 60 * 1000);
    user.passwordResetOtpAttempts = 0;
    user.passwordResetToken = crypto.randomBytes(20).toString('hex');
    user.passwordResetExpires = user.passwordResetOtpExpires;
    await user.save();

    // Email sending not configured in this minimal service — log OTP in non-production
    if (process.env.NODE_ENV !== 'production') {
        console.log('[auth] Password reset OTP for', email, ':', otp);
    }
    return { ...generic, ...(process.env.NODE_ENV !== 'production' ? { debugOtp: otp } : {}) };
}

async function resetPassword({ token, otp, email, newPassword, ip }) {
    if (!newPassword || newPassword.length < 8) throw new Error('Password must be at least 8 characters');
    email = String(email || '').trim().toLowerCase();

    let user = null;
    if (email) user = await User.findOne({ email });
    if (!user && token) user = await User.findOne({ passwordResetToken: token });
    if (!user) throw new Error('Invalid reset request');

    if (!user.passwordResetOtpExpires || user.passwordResetOtpExpires < new Date()) {
        throw new Error('Reset code expired');
    }
    if ((user.passwordResetOtpAttempts || 0) >= 5) throw new Error('Too many attempts');

    if (otp) {
        const hash = crypto.createHash('sha256').update(String(otp)).digest('hex');
        if (hash !== user.passwordResetOtpHash) {
            user.passwordResetOtpAttempts = (user.passwordResetOtpAttempts || 0) + 1;
            await user.save();
            throw new Error('Invalid OTP');
        }
    } else if (token) {
        if (user.passwordResetToken !== token) throw new Error('Invalid token');
    } else {
        throw new Error('OTP or token required');
    }

    user.password = newPassword;
    user.passwordResetOtpHash = null;
    user.passwordResetOtpExpires = null;
    user.passwordResetOtpAttempts = 0;
    user.passwordResetToken = null;
    user.passwordResetExpires = null;
    await user.save();

    await forceLogoutUser(user._id);
    return { success: true, message: 'Password updated' };
}

async function verifyEmail({ token, email }) {
    // Minimal: mark verified if user exists
    email = String(email || '').trim().toLowerCase();
    const user = await User.findOne({ email });
    if (!user) throw new Error('User not found');
    user.emailVerified = true;
    user.emailVerificationToken = null;
    user.emailVerificationExpires = null;
    await user.save();
    return { success: true, message: 'Email verified' };
}

module.exports = {
    generateAccessToken,
    registerParent,
    loginUser,
    refreshAccessToken,
    logoutUser,
    forceLogoutUser,
    requestPasswordReset,
    resetPassword,
    verifyEmail,
};
