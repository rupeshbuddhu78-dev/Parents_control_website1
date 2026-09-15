# Secure Gallery Fix (binary/text flag)

## Root cause (confirmed from live logs)

Child logged `Gallery P2P transfer complete items=100` and DataChannel was OPEN on parent,
but parent never received manifest / file-start control frames → 0 photos shown.

WebRTC DataChannel.Buffer flag was **inverted** on Android:

| Frame type | Correct `binary` | Old (broken) code |
|------------|------------------|-------------------|
| Text (manifest, file-start, file-end, gallery-complete) | `false` | `true` |
| Binary image chunks | `true` | `false` |

Browser therefore got:
- Control JSON as binary → ignored by `typeof data === 'string'` check
- JPEG bytes as text → unusable

## Fixes in this package

### Child (`GalleryUploader.java`)
- `sendText(...)` now uses `binary=false`
- Image chunks now use `binary=true`

### Parent (`view_gallery.html`)
- `handleData` also accepts control frames delivered as `ArrayBuffer` or `Blob`
- Existing missing-files → Socket.IO relay fallback kept

## Deploy
1. Rebuild + install child APK from the fixed child zip.
2. Deploy updated `parent/view_gallery.html` (or full parent zip).
3. Hard-refresh gallery page (clear cache if needed), press **Load Photos**.
