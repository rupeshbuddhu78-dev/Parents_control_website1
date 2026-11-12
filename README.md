<div align="center">

# 👨‍👩‍👧‍👦 Parents Control

<img src="https://readme-typing-svg.demolab.com?font=Fira+Code&weight=700&size=23&pause=1000&color=5B8DEF&center=true&vCenter=true&width=760&lines=A+parent-focused+device+management+platform;Web+dashboard+%2B+Node.js+API;Real-time+signaling+with+Socket.IO;WebRTC+offers%2C+answers+%26+ICE+candidates" alt="Animated project introduction" />

A parent-facing web dashboard and Node.js server for managing paired devices. The server provides account and device APIs, admin and subscription flows, and real-time communication between authorized clients and devices.

[🌐 Live Website](https://parents-control-website-ctia.onrender.com) · [✨ Features](#-features) · [🧱 Architecture](#-architecture) · [🚀 Getting Started](#-getting-started) · [🔐 Security & Privacy](#-security--privacy)

</div>

---

## ✨ Features

- Parent account registration, login, JWT access tokens, refresh-token rotation, email verification, and password reset flows.
- Device pairing and ownership-aware parent/device management.
- Admin dashboard and APIs for parent accounts, devices, subscriptions, payments, and audit events.
- Subscription plans and Cashfree payment/webhook integration.
- Socket.IO connections for device presence, command acknowledgements, and targeted event relay.
- WebRTC signaling event relay for screen, camera, audio, gallery, and storage-related peer connections.
- Device data and media upload routes, with Cloudinary integration available for media workflows.
- Responsive parent-facing HTML pages served by Express.

> This repository contains the web frontend and server. The project documentation references a companion Android child app; Android source code may be maintained separately.

## 🧱 Architecture

```text
Parent web dashboard ── HTTPS / REST ──┐
                                       ├── Express server ── MongoDB
Parent web dashboard ── Socket.IO ─────┤        │
                                       │        ├── Cashfree payments/webhooks
Paired device app ───── Socket.IO ─────┘        └── Cloudinary uploads
            │
            └── WebRTC peer connection (media/data when supported by clients)
                 Socket.IO relays signaling; it is not itself the WebRTC media stream.
```

### WebRTC and WebSocket/Socket.IO

The server creates an HTTP server and attaches **Socket.IO** at `/socket.io`. Socket.IO can use WebSocket or HTTP long-polling transport. It handles room membership, device status, targeted commands and acknowledgements, and relays signaling events such as `screen-offer`, `screen-answer`, `screen-candidate`, `camera-offer`, `audio-offer`, and related gallery/storage events.

In a WebRTC flow, clients exchange offer/answer descriptions and ICE candidates through this signaling channel, then attempt a peer connection. The server's signaling relay does not mean that it records or carries every WebRTC media stream; the actual media/data path depends on the client implementation and network configuration (including any STUN/TURN setup).

The server also contains separate Socket.IO relay handlers for `screen-frame` and `audio-stream` events. These are server-relayed payloads, distinct from a direct WebRTC peer connection.

## 🧰 Tech Stack

| Area | Technologies |
| --- | --- |
| Server | Node.js 20.19.1, Express 4 |
| Realtime | Socket.IO 4 |
| Database | MongoDB, Mongoose 8 |
| Authentication | JSON Web Tokens, bcryptjs, refresh-token rotation |
| Security | Helmet, CORS configuration, express-rate-limit |
| Uploads and media | Multer, Cloudinary |
| Payments | Cashfree integration |
| Frontend | HTML, CSS, browser JavaScript |

## 📁 Project Structure

```text
Parents_control_website1/
├── parent/                 # Parent/admin web pages
├── server/
│   ├── app.js              # Express app and static page serving
│   ├── server.js           # HTTP server and Socket.IO event relay
│   ├── config/             # Environment, database, and service config
│   ├── controllers/        # API controllers
│   ├── middleware/         # Auth, ownership, rate limits, errors
│   ├── models/             # Mongoose models
│   ├── routes/             # REST API routes
│   ├── scripts/            # Admin and plan seed scripts
│   ├── services/           # Device and domain services
│   └── tests/              # Basic structural tests
├── package.json
├── ENV.example
└── SECURITY_AUDIT_FINAL.md
```

## 🚀 Getting Started

### Prerequisites

- Node.js **20.19.1** (as specified in `package.json`) and npm
- A MongoDB instance or MongoDB Atlas database
- Optional provider accounts for SMTP email, Cloudinary, and Cashfree

### 1. Clone and install

```bash
git clone https://github.com/rupeshbuddhu78-dev/Parents_control_website1.git
cd Parents_control_website1
npm install
```

### 2. Configure environment

Copy `ENV.example` to `.env` and set your values:

```bash
cp ENV.example .env
```

At minimum, configure a MongoDB URI and strong, unique JWT secrets. For admin setup, configure `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and `ADMIN_NAME`. Add SMTP, Cloudinary, Cashfree, and production CORS settings only when those integrations are required.

Generate strong secrets locally rather than using the example placeholders:

```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

Use a different generated value for each JWT secret. Never commit `.env` or provider credentials.

### 3. Seed initial data (as needed)

```bash
npm run seed:admin
npm run seed:plans
```

Configure the seed environment values before running these commands. The admin setup guide documents the single-admin account flow.

### 4. Start the server

```bash
npm start
```

For development, the repository does not currently list a watch-mode script. The default port is `3000`; set `PORT` in `.env` or the hosting environment to override it. The web app is served from the `parent/` directory.

## 🧪 Tests

Run the repository's basic test suite with:

```bash
npm test
```

The included testing report records **63/63 structural tests passed** for its report date. It also notes that end-to-end flows requiring MongoDB, SMTP, Cashfree credentials, or a physical Android device were not exercised in that report; validate those integrations in your own environment.

## ☁️ Deployment

The project includes Render-oriented configuration and an example `APP_URL`. For a Node web service, use:

- **Build command:** `npm install`
- **Start command:** `npm start`
- **Environment:** configure MongoDB, JWT secrets, `NODE_ENV=production`, and all required provider variables in the host dashboard.
- **CORS:** set `CORS_ORIGINS` to the exact trusted website origins; do not rely on a wildcard in production.

Live website referenced by the repository: [parents-control-website-ctia.onrender.com](https://parents-control-website-ctia.onrender.com).

## 🔐 Security & Privacy

This application deals with sensitive device and family data. Use it only on devices you own or are explicitly authorized to manage, with clear notice and consent consistent with applicable laws and platform policies. Do not use it for covert monitoring.

Before production deployment:

- Set strong `JWT_SECRET` and `JWT_REFRESH_SECRET` values and keep them private.
- Set `CORS_ORIGINS` to trusted domains, configure HTTPS, and use `NODE_ENV=production`.
- Review the security audit and its **remaining items**. It notes legacy device API endpoints may remain open for backward compatibility; verify and restrict these before relying on the service.
- Use secure Android storage and review documented remaining Android items, such as hardcoded configuration values.
- Protect uploaded media, admin credentials, account recovery channels, and database backups.
- Test authentication, device ownership checks, Socket.IO authorization, and payment webhook verification on the deployed configuration.

See [`SECURITY_AUDIT_FINAL.md`](SECURITY_AUDIT_FINAL.md), [`ADMIN_LOGIN_GUIDE.md`](ADMIN_LOGIN_GUIDE.md), and [`TESTING_REPORT.md`](TESTING_REPORT.md) for additional project notes.

## 📄 License

No open-source license is currently specified. Contact the repository owner before reuse or redistribution.

---

<div align="center">

Built for safer, transparent family device management 💙

</div>
