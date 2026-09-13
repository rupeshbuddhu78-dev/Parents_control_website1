# API security lockdown (non-breaking)

## Protected (parent JWT + device ownership)
- POST /api/send-command
- POST /api/wipe-device, /clear-data, /set-pin
- GET /api/get-data/*, gallery-list, audio-history, folder-list, device-status
- GET /api/activity-events, boot-events, boot-status
- Socket.IO event `send-command` (requires token in payload or handshake.auth)

## Protected (admin JWT)
- GET /api/admin/all-devices

## Child device (no parent JWT) — must be paired
- POST /api/status, uploads, boot-status, gallery fallback upload
- requirePairedDevice + legacy User.devices fallback

## Frontend
- All parent HTML: auto-attach Bearer access_token on /api/ fetches
- Socket send-command includes token where patched

## Deploy
1. Deploy this website zip to Render
2. Ensure JWT_SECRET is strong in env
3. Set CORS_ORIGINS to your domain
4. Existing paired devices keep working; unpaired random IDs blocked
