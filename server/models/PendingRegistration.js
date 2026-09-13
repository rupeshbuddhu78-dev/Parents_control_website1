'use strict';

const { mongoose } = require('../config/db');

const PendingRegistrationSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    name: { type: String, required: true, trim: true },
    password: { type: String, required: true }, // plain password, will be hashed when User is created
    otpHash: { type: String, required: true }, // SHA-256 hash of OTP
    otpExpires: { type: Date, required: true },
    otpAttempts: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now },
}, { collection: 'pending_registrations' });

// Auto-delete expired entries after 20 minutes
PendingRegistrationSchema.index({ otpExpires: 1 }, { expireAfterSeconds: 0 });

const PendingRegistration = mongoose.models.PendingRegistration || mongoose.model('PendingRegistration', PendingRegistrationSchema);

module.exports = PendingRegistration;
