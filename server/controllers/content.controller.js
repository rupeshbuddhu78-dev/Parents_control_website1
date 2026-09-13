'use strict';

const SiteContent = require('../models/SiteContent');

// GET /api/admin/site-content?page=home
async function getSiteContent(req, res) {
    try {
        const page = req.query.page || 'home';
        let content = await SiteContent.findOne({ page }).lean();
        if (!content) {
            // Return empty structure
            content = { page, items: [] };
        }
        res.json(content);
    } catch (e) {
        res.status(500).json({ error: 'Failed to get site content' });
    }
}

// PUT /api/admin/site-content
// Body: { page: 'home', items: [{ key, label, value, type, section, order }] }
async function saveSiteContent(req, res) {
    try {
        const { page, items } = req.body;
        if (!page) return res.status(400).json({ error: 'Page is required' });
        if (!Array.isArray(items)) return res.status(400).json({ error: 'Items must be an array' });

        const cleaned = items.map(item => ({
            key: String(item.key || '').trim(),
            label: String(item.label || '').trim(),
            value: item.value,
            type: item.type || 'text',
            section: String(item.section || 'general').trim(),
            order: Number(item.order) || 0,
        })).filter(item => item.key);

        const content = await SiteContent.findOneAndUpdate(
            { page },
            { $set: { items: cleaned, updatedAt: new Date() } },
            { new: true, upsert: true, runValidators: true }
        );
        res.json({ success: true, content });
    } catch (e) {
        res.status(500).json({ error: 'Failed to save site content: ' + e.message });
    }
}

// PATCH /api/admin/site-content/item
// Body: { page, key, value }
async function updateSingleItem(req, res) {
    try {
        const { page, key, value, label, type, section, order } = req.body;
        if (!page || !key) return res.status(400).json({ error: 'Page and key are required' });

        const content = await SiteContent.findOne({ page });
        if (!content) {
            // Create new
            const newItem = { key, label: label || key, value, type: type || 'text', section: section || 'general', order: order || 0 };
            const created = await SiteContent.create({ page, items: [newItem] });
            return res.json({ success: true, content: created });
        }

        const idx = content.items.findIndex(i => i.key === key);
        if (idx >= 0) {
            content.items[idx].value = value;
            if (label !== undefined) content.items[idx].label = label;
            if (type !== undefined) content.items[idx].type = type;
            if (section !== undefined) content.items[idx].section = section;
            if (order !== undefined) content.items[idx].order = order;
        } else {
            content.items.push({ key, label: label || key, value, type: type || 'text', section: section || 'general', order: order || 0 });
        }
        content.updatedAt = new Date();
        await content.save();
        res.json({ success: true, content });
    } catch (e) {
        res.status(500).json({ error: 'Failed to update item: ' + e.message });
    }
}

// DELETE /api/admin/site-content/item
// Body: { page, key }
async function deleteSingleItem(req, res) {
    try {
        const { page, key } = req.body;
        if (!page || !key) return res.status(400).json({ error: 'Page and key are required' });

        const content = await SiteContent.findOne({ page });
        if (!content) return res.status(404).json({ error: 'Content not found' });

        content.items = content.items.filter(i => i.key !== key);
        content.updatedAt = new Date();
        await content.save();
        res.json({ success: true, content });
    } catch (e) {
        res.status(500).json({ error: 'Failed to delete item: ' + e.message });
    }
}

// POST /api/admin/site-content/add-item
// Body: { page, key, label, value, type, section, order }
async function addNewItem(req, res) {
    try {
        const { page, key, label, value, type, section, order } = req.body;
        if (!page || !key) return res.status(400).json({ error: 'Page and key are required' });

        let content = await SiteContent.findOne({ page });
        if (!content) {
            content = await SiteContent.create({
                page,
                items: [{ key, label: label || key, value: value || '', type: type || 'text', section: section || 'general', order: order || 0 }]
            });
            return res.json({ success: true, content });
        }

        // Check if key already exists
        const existing = content.items.find(i => i.key === key);
        if (existing) {
            return res.status(400).json({ error: 'Key already exists. Use update instead.' });
        }

        content.items.push({ key, label: label || key, value: value || '', type: type || 'text', section: section || 'general', order: order || 0 });
        content.updatedAt = new Date();
        await content.save();
        res.json({ success: true, content });
    } catch (e) {
        res.status(500).json({ error: 'Failed to add item: ' + e.message });
    }
}

// PUBLIC: GET /api/site-content?page=home
async function getPublicSiteContent(req, res) {
    try {
        const page = req.query.page || 'home';
        const content = await SiteContent.findOne({ page }).lean();
        if (!content || !content.items || content.items.length === 0) {
            return res.json({ page, items: [], hasContent: false });
        }
        // Return simplified structure for public use
        const items = {};
        content.items.forEach(item => {
            items[item.key] = item.value;
        });
        res.json({ page, items, hasContent: true });
    } catch (e) {
        res.status(500).json({ error: 'Failed to get content' });
    }
}

module.exports = {
    getSiteContent,
    saveSiteContent,
    updateSingleItem,
    deleteSingleItem,
    addNewItem,
    getPublicSiteContent,
};
