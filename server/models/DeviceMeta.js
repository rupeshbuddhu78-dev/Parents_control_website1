'use strict';

const { mongoose } = require('../config/db');

const DeviceMetaSchema = new mongoose.Schema({
    deviceId: { type: String, unique: true, index: true },
    model: String,
    manufacturer: String,
    androidVersion: String,
    sdkVersion: String,
    appVersion: String,
    battery: { type: Number, default: null },
    charging: { type: Boolean, default: null },
    pin: String,
    // Network payload from device (type, wifi, ssid, ip, ipv4, ipv6, carrier, operator, signalStrength, mobileNetworkType, ...)
    network: mongoose.Schema.Types.Mixed,
    // SIM payload from device (count, active, operator, carrier, country, phoneNumber, ...)
    sim: mongoose.Schema.Types.Mixed,
    // Last known location { latitude/lat, longitude/lon, accuracy, speed, timestamp, ... }
    lastLocation: mongoose.Schema.Types.Mixed,
    lastSeen: Number,
    updatedAt: { type: Date, default: Date.now }
}, { collection: 'devices' });

const DeviceMeta = mongoose.models.DeviceMeta || mongoose.model('DeviceMeta', DeviceMetaSchema);

module.exports = DeviceMeta;
