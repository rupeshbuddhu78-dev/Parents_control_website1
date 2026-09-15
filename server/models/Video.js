'use strict';

const mongoose = require('mongoose');

const videoSchema = new mongoose.Schema({
    type: {
        type: String,
        required: true,
        enum: ['setup', 'control'],
    },
    // For setup videos: phone brand name (Vivo, Redmi, Samsung, Motorola, ...)
    // For control: optional label e.g. "How to Control"
    title: {
        type: String,
        default: '',
        trim: true,
    },
    url: {
        type: String,
        required: true,
    },
    cloudinaryId: {
        type: String,
        required: true,
    },
    thumbnail: {
        type: String,
        default: null,
    },
    thumbnailId: {
        type: String,
        default: null,
    },
    uploadedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
}, { timestamps: true });

module.exports = mongoose.model('Video', videoSchema);
