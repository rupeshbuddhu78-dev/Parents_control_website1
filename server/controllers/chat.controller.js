'use strict';

const fs = require('fs');
const path = require('path');
const db = require('../config/db');
const dbService = require('../services/database.service');
const { isStrictChatRecordForApp } = require('../utils/validators');

// GET /api/chats
async function getChats(req, res) {
    const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
    const { device, childId, app, contact, search, limit } = req.query;
    const child = device || childId;
    if (!child || !app) return res.status(400).json({ error: "Missing device/childId or app" });
    const id = child.toString().trim().toUpperCase();
    const appKey = String(app).toLowerCase();
    if (!['whatsapp', 'instagram', 'snapchat'].includes(appKey)) return res.status(400).json({ error: "Unsupported app" });
    const lim = Math.min(Math.max(parseInt(limit) || 500, 1), 5000);
    res.set('Cache-Control', 'no-store');
    try {
        await db.ensureReady();
        let chats = await dbService.loadChatMessages(id, appKey, contact || 'all', lim);
        if (!chats || chats.length === 0) {
            const filePath = path.join(UPLOADS_DIR, 'chats', id, `${appKey}.json`);
            if (fs.existsSync(filePath)) {
                chats = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                chats = (Array.isArray(chats) ? chats : []).filter(row => isStrictChatRecordForApp(row, appKey));
                if (contact && contact !== 'all') {
                    const wanted = String(contact).toLowerCase();
                    chats = chats.filter(c => String(c.conversation || '').toLowerCase() === wanted);
                }
            }
        }
        if (!Array.isArray(chats)) chats = [];
        if (search) {
            const q = String(search).toLowerCase();
            chats = chats.filter(c => (c.text && c.text.toLowerCase().includes(q)) || (c.sender && c.sender.toLowerCase().includes(q)));
        }
        chats = chats.map((row) => ({
            ...row,
            conversation: row.conversation || row.contact || row.contactName || row.sender || '',
            text: row.text || row.message || '',
            message: row.message || row.text || '',
            timestamp: Number(row.timestamp || row.clientTimestamp || row.serverTimestamp || new Date(row.createdAt || 0).getTime() || 0),
        })).filter((row) => row.conversation && row.text);
        chats.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        res.json(chats.slice(0, lim));
    } catch (e) {
        console.error('/api/chats', e.message);
        res.json([]);
    }
}

// GET /api/chat_contacts
async function getChatContacts(req, res) {
    const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
    const { device, childId, app } = req.query;
    const child = device || childId;
    if (!child || !app) return res.status(400).json({ error: "Missing device/childId or app" });
    const id = child.toString().trim().toUpperCase();
    const appKey = String(app).toLowerCase();
    if (!['whatsapp', 'instagram', 'snapchat'].includes(appKey)) return res.status(400).json({ error: "Unsupported app" });
    res.set('Cache-Control', 'no-store');
    try {
        await db.ensureReady();
        let contacts = await dbService.loadChatContacts(id, appKey);
        if (!contacts || contacts.length === 0) {
            const filePath = path.join(UPLOADS_DIR, 'chats', id, `${appKey}.json`);
            if (fs.existsSync(filePath)) {
                const chats = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                const contactMap = {};
                (Array.isArray(chats) ? chats : []).filter(row => isStrictChatRecordForApp(row, appKey)).forEach(c => {
                    const conv = c.conversation || c.contact || c.contactName || c.sender || 'Unknown';
                    if (!contactMap[conv]) {
                        contactMap[conv] = { conversation: conv, lastMessage: '', timestamp: 0, count: 0, lastDirection: 'IN' };
                    }
                    contactMap[conv].count++;
                    if ((c.timestamp || 0) > contactMap[conv].timestamp) {
                        contactMap[conv].timestamp = c.timestamp;
                        contactMap[conv].lastMessage = c.text || c.message || '';
                        contactMap[conv].lastDirection = c.direction || 'IN';
                    }
                });
                contacts = Object.values(contactMap).sort((a, b) => b.timestamp - a.timestamp);
            }
        }
        contacts = (contacts || []).map((row) => ({
            ...row,
            conversation: row.conversation || row.contact || row.contactName || row.sender || '',
            contact: row.contact || row.conversation || row.contactName || row.sender || '',
            lastMessage: typeof row.lastMessage === 'string' ? row.lastMessage : (row.text || row.message || ''),
            timestamp: Number(row.timestamp || row.lastTime || row.serverTimestamp || 0),
        })).filter((row) => row.conversation);
        res.json(contacts);
    } catch (e) {
        console.error('/api/chat_contacts', e.message);
        res.json([]);
    }
}

module.exports = { getChats, getChatContacts };
