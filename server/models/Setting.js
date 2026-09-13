'use strict';

const mongoose = require('mongoose');

const SettingSchema = new mongoose.Schema({
    key: {
        type: String,
        required: true,
        unique: true,
        index: true,
    },
    value: {
        type: mongoose.Schema.Types.Mixed,
        default: null,
    },
    description: {
        type: String,
        default: '',
    },
    updatedAt: {
        type: Date,
        default: Date.now,
    },
}, {
    timestamps: false,
});

// Helper methods
SettingSchema.statics.get = async function(key, defaultValue = null) {
    const setting = await this.findOne({ key }).lean();
    return setting ? setting.value : defaultValue;
};

SettingSchema.statics.set = async function(key, value, description = '') {
    return this.findOneAndUpdate(
        { key },
        { $set: { value, description, updatedAt: new Date() } },
        { upsert: true, new: true }
    ).lean();
};

module.exports = mongoose.model('Setting', SettingSchema);
