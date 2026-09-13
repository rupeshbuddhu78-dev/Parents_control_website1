'use strict';

const { mongoose } = require('../config/db');

const ContentItemSchema = new mongoose.Schema({
    key: { type: String, required: true },          // e.g. "hero_title", "price_card_1_name"
    label: { type: String, default: '' },            // Human-readable label for admin UI
    value: { type: mongoose.Schema.Types.Mixed, default: '' }, // String, number, or array
    type: { type: String, enum: ['text', 'number', 'richtext', 'array', 'json'], default: 'text' },
    section: { type: String, required: true },       // e.g. "hero", "features", "pricing", "faq", "footer"
    order: { type: Number, default: 0 },
}, { _id: true });

const SiteContentSchema = new mongoose.Schema({
    page: { type: String, required: true, default: 'home', unique: true },
    items: [ContentItemSchema],
    updatedAt: { type: Date, default: Date.now },
}, { collection: 'site_contents' });

const SiteContent = mongoose.models.SiteContent || mongoose.model('SiteContent', SiteContentSchema);

module.exports = SiteContent;
