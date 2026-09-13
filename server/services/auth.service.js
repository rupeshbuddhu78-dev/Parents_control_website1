'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const RefreshToken = require('../models/RefreshToken');
const PendingRegistration = require('../models/PendingRegistration');
const env = require('../config/env');

// Google Apps Script URL for sending OTP emails
// Deploy a Google Apps Script with doPost() that accepts {email, otp, name, type}
// and sends email via GmailApp. Set GAS_EMAIL_URL env var.
const GOOGLE_SCRIPT_URL = process.env.GAS_EMAIL_URL || process.env.GOOGLE_SCRIPT_URL || '';

async function sendOtpViaGoogleScript(email, otp, name, type) {
    if (!GOOGLE_SCRIPT_URL) {
        console.log('[OTP] No Google Script URL configured. OTP for', email, ':', otp);
        return { success: false, reason: 'no_script_url' };
    }
    try {
        // Build a nice HTML email body based on type
        let subject, htmlBody;

        if (type === 'registration') {
            subject = 'Verify Your Email - Child Monitor';
            htmlBody = `
                <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;background:#0B0D17;color:#fff;border-radius:16px;overflow:hidden;border:1px solid rgba(255,255,255,0.1)">
                    <div style="background:linear-gradient(135deg,#6C5CE7,#00CEFF);padding:32px;text-align:center">
                        <h1 style="margin:0;font-size:24px;color:#fff">Child Monitor</h1>
                        <p style="margin:8px 0 0;opacity:0.8;font-size:14px;color:#fff">Verify Your Email</p>
                    </div>
                    <div style="padding:32px">
                        <p style="font-size:16px;margin:0 0 20px">Hi <strong>${name}</strong>,</p>
                        <p style="font-size:14px;color:#aaa;margin:0 0 24px">Use this code to complete your registration:</p>
                        <div style="background:rgba(108,92,231,0.15);border:2px solid #6C5CE7;border-radius:12px;padding:20px;text-align:center;margin:0 auto 24px">
                            <span style="font-size:32px;font-weight:bold;letter-spacing:6px;color:#A29BFE;white-space:nowrap;display:inline-block;word-break:keep-all">${otp}</span>
                        </div>
                        <p style="font-size:13px;color:#666;margin:0 0 8px">This code expires in <strong>15 minutes</strong>.</p>
                        <p style="font-size:13px;color:#666;margin:0">If you did not request this, please ignore this email.</p>
                    </div>
                </div>`;
        } else if (type === 'password_reset') {
            subject = 'Password Reset Code - Child Monitor';
            htmlBody = `
                <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;background:#0B0D17;color:#fff;border-radius:16px;overflow:hidden;border:1px solid rgba(255,255,255,0.1)">
                    <div style="background:linear-gradient(135deg,#6C5CE7,#00CEFF);padding:32px;text-align:center">
                        <h1 style="margin:0;font-size:24px;color:#fff">Child Monitor</h1>
                        <p style="margin:8px 0 0;opacity:0.8;font-size:14px;color:#fff">Password Reset</p>
                    </div>
                    <div style="padding:32px">
                        <p style="font-size:16px;margin:0 0 20px">Hi <strong>${name}</strong>,</p>
                        <p style="font-size:14px;color:#aaa;margin:0 0 24px">Use this code to reset your password:</p>
                        <div style="background:rgba(108,92,231,0.15);border:2px solid #6C5CE7;border-radius:12px;padding:20px;text-align:center;margin:0 auto 24px">
                            <span style="font-size:32px;font-weight:bold;letter-spacing:6px;color:#A29BFE;white-space:nowrap;display:inline-block;word-break:keep-all">${otp}</span>
                        </div>
                        <p style="font-size:13px;color:#666;margin:0 0 8px">This code expires in <strong>15 minutes</strong>.</p>
                        <p style="font-size:13px;color:#666;margin:0">If you did not request this, please ignore this email.</p>
                    </div>
                </div>`;
        } else {
            subject = 'Your Code - Child Monitor';
            htmlBody = `
                <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;background:#0B0D17;color:#fff;border-radius:16px;overflow:hidden;border:1px solid rgba(255,255,255,0.1)">
                    <div style="background:linear-gradient(135deg,#6C5CE7,#00CEFF);padding:32px;text-align:center">
                        <h1 style="margin:0;font-size:24px;color:#fff">Child Monitor</h1>
                    </div>
                    <div style="padding:32px">
                        <p style="font-size:16px;margin:0 0 20px">Hi <strong>${name}</strong>,</p>
                        <div style="background:rgba(108,92,231,0.15);border:2px solid #6C5CE7;border-radius:12px;padding:20px;text-align:center;margin:0 auto 24px">
                            <span style="font-size:32px;font-weight:bold;letter-spacing:6px;color:#A29BFE;white-space:nowrap;display:inline-block;word-break:keep-all">${otp}</span>
                        </div>
                        <p style="font-size:13px;color:#666;margin:0">This code expires in 15 minutes.</p>
                    </div>
                </div>`;
        }

        // Send in format that matches the GAS script: { to, subject, htmlBody }
        const payload = JSON.stringify({ to: email, subject, htmlBody });

        console.log('[OTP] Sending OTP to', email, 'via Google Apps Script...');

        const response = await fetch(GOOGLE_SCRIPT_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: payload,
            redirect: 'follow',
        });

        const contentType = response.headers.get('content-type') || '';
        let result;
        if (contentType.includes('application/json')) {
            result = await response.json();
        } else {
            result = await response.text();
        }
        console.log('[OTP] Google Script response status:', response.status, 'body:', typeof result === 'string' ? result.substring(0, 300) : JSON.stringify(result));

        if (response.ok) {
            return { success: true };
        }
        return { success: false, reason: 'HTTP ' + response.status };
    } catch (err) {
        console.error('[OTP] Google Script fetch error:', err.message);
        return { success: false, reason: err.message };
    }
}

// ─── Pending registration store (MongoDB) ────────────────────────────────────
// Stores registration data temporarily until OTP is verified.
// Data persists across server restarts (unlike in-memory Map).
// Auto-deleted by MongoDB TTL index after otpExpires time.

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
    // Registration must go through OTP flow: sendRegistrationOtp -> verifyRegistrationOtp
    // Direct registration without OTP verification is disabled.
    throw new Error('Direct registration is disabled. Please use the OTP verification flow.');
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

// Helper: mask email for display (e.g. "sw****p@gmail.com")
function maskEmail(email) {
    if (!email || !email.includes('@')) return email;
    const [local, domain] = email.split('@');
    if (local.length <= 2) return local[0] + '***@' + domain;
    return local[0] + '***' + local[local.length - 1] + '@' + domain;
}

async function requestPasswordReset({ email, ip }) {
    email = String(email || '').trim().toLowerCase();
    if (!email) throw new Error('Please enter your registered email');

    const user = await User.findOne({ email });
    if (!user) {
        // Email not registered — tell user clearly instead of silently faking success
        throw new Error('This email is not registered. Please register first.');
    }

    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const hash = crypto.createHash('sha256').update(otp).digest('hex');
    user.passwordResetOtpHash = hash;
    user.passwordResetOtpExpires = new Date(Date.now() + 15 * 60 * 1000);
    user.passwordResetOtpAttempts = 0;
    user.passwordResetToken = crypto.randomBytes(20).toString('hex');
    user.passwordResetExpires = user.passwordResetOtpExpires;
    await user.save();

    // Send OTP via Google Apps Script — only to the registered email
    const sent = await sendOtpViaGoogleScript(email, otp, user.name, 'password_reset');

    if (process.env.NODE_ENV !== 'production') {
        console.log('[auth] Password reset OTP for', email, ':', otp);
    }

    // If email sending failed, tell user clearly
    if (!sent.success) {
        if (sent.reason === 'no_script_url') {
            console.error('[auth] GOOGLE_SCRIPT_URL not set — cannot send password reset OTP');
            throw new Error('Email service not configured. Please contact support.');
        }
        throw new Error('Failed to send OTP email. Please try again.');
    }

    // Return masked email so frontend can show where OTP was sent
    return {
        success: true,
        message: 'OTP sent to your registered email',
        maskedEmail: maskEmail(email),
        ...(process.env.NODE_ENV !== 'production' ? { debugOtp: otp } : {}),
    };
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

// ─── Registration OTP Flow ──────────────────────────────────────────────────

async function sendRegistrationOtp({ email, name, password, ip }) {
    email = String(email || '').trim().toLowerCase();
    name = String(name || '').trim();
    if (!email || !password || password.length < 8) {
        throw new Error('Valid email and password (min 8 chars) required');
    }
    if (!name) name = email.split('@')[0];

    // Check if email already registered (fully verified user)
    const existing = await User.findOne({ email });
    if (existing) throw new Error('Email already registered');

    // Generate 6-digit OTP
    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const hash = crypto.createHash('sha256').update(otp).digest('hex');

    // Send OTP via Google Apps Script FIRST — before storing anything
    const sent = await sendOtpViaGoogleScript(email, otp, name, 'registration');

    if (!sent.success) {
        if (sent.reason === 'no_script_url') {
            console.warn('[auth] GOOGLE_SCRIPT_URL not set — cannot send registration OTP via email');
            throw new Error('Email service not configured. Please contact support.');
        }
        throw new Error('Failed to send OTP. Please try again.');
    }

    // OTP sent successfully — now store pending registration in MongoDB
    // (NOT creating User yet — account is NOT created until OTP is verified)
    await PendingRegistration.findOneAndUpdate(
        { email },
        {
            email,
            name,
            password, // will be hashed when User is created after OTP verification
            otpHash: hash,
            otpExpires: new Date(Date.now() + 15 * 60 * 1000), // 15 min
            otpAttempts: 0,
        },
        { upsert: true, new: true }
    );

    if (process.env.NODE_ENV !== 'production') {
        console.log('[auth] Registration OTP for', email, ':', otp);
    }

    return {
        success: true,
        message: 'OTP sent to your email',
        ...(process.env.NODE_ENV !== 'production' ? { debugOtp: otp } : {}),
    };
}

async function verifyRegistrationOtp({ email, otp, ip, userAgent }) {
    email = String(email || '').trim().toLowerCase();
    if (!email || !otp) throw new Error('Email and OTP required');

    // Get pending registration from MongoDB
    const pending = await PendingRegistration.findOne({ email });
    if (!pending) throw new Error('No pending registration found. Please register again.');

    // Check expiry
    if (!pending.otpExpires || pending.otpExpires < new Date()) {
        await PendingRegistration.deleteOne({ email });
        throw new Error('OTP expired. Please register again.');
    }

    // Check attempts
    if ((pending.otpAttempts || 0) >= 5) {
        await PendingRegistration.deleteOne({ email });
        throw new Error('Too many attempts. Please register again.');
    }

    // Verify OTP
    const hash = crypto.createHash('sha256').update(String(otp)).digest('hex');
    if (hash !== pending.otpHash) {
        pending.otpAttempts = (pending.otpAttempts || 0) + 1;
        await pending.save();
        throw new Error('Invalid OTP');
    }

    // OTP verified — NOW create the actual User account
    // Check again if email was registered in the meantime
    const existingUser = await User.findOne({ email });
    if (existingUser) {
        await PendingRegistration.deleteOne({ email });
        throw new Error('Email already registered');
    }

    const user = new User({
        email: pending.email,
        name: pending.name,
        password: pending.password, // Will be hashed by pre-save hook
        role: 'PARENT',
        status: 'active',
        emailVerified: true,
    });
    await user.save();

    // Clean up pending registration
    await PendingRegistration.deleteOne({ email });

    // Set last login
    user.lastLogin = new Date();
    user.lastLoginIp = ip || '';
    await user.save();

    // Generate tokens
    const accessToken = generateAccessToken(user);
    const refreshToken = await createRefreshToken(user._id, { ip, userAgent });

    return {
        success: true,
        message: 'Registration verified successfully',
        accessToken,
        refreshToken,
        user: publicUser(user),
    };
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
    sendRegistrationOtp,
    verifyRegistrationOtp,
};
