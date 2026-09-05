'use strict';

const mongoose = require('mongoose');

const videoSchema = new mongoose.Schema({
    type: {
        type: String,
        required: true,
        enum: ['setup', 'control'],
    },
    url: {
        type: String,
        required: true,
    },
    cloudinaryId: {
        type: String,
        required: true,
    },
    uploadedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
}, { timestamps: true });

module.exports = mongoose.model('Video', videoSchema);
