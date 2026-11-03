# JTech Assistant

A high-performance personal WhatsApp AI assistant for **JTech** with a modular Node.js backend, mobile-first app dashboard (iOS/Android native feel, bottom navigation, hash routing, 100dvh safe-area support), 3-tier prompt architecture, live chat viewer, and real-time Redis memory.

---

## File Structure & Module Map

The backend is refactored into modular ES components with `server.js` as an entry file (< 30 lines) compatible with Render (`node server.js`):

```
├── server.js                        # App entry point (< 30 lines) mounting Express & routers
├── ui.html                          # Self-contained mobile-first PWA dashboard (HTML/CSS/JS)
├── package.json                     # Node 22.x engine, dependencies, scripts
├── README.md                        # Architecture & deployment documentation
└── server/
    ├── config.js                    # Env vars, model constants, TTLs, and defaults
    ├── state.js                     # Centralized mutable runtime state (socket, pairing, errors)
    ├── lib/
    │   ├── logger.js                # Circular in-app event log ring buffer (last 20 events)
    │   ├── redis.js                 # Upstash Redis REST store (automaticDeserialization: false)
    │   └── settings.js              # Settings cache & automatic legacy baseRules migration
    ├── brain/
    │   ├── core-brain.js            # Immutable backend-only Core Brain & safety guardrails
    │   └── prompt-builder.js        # 3-tier prompt assembler & Africa/Freetown clock
    ├── ai/
    │   ├── gemini.js                # Google Gemini client (timeout, 1 retry on 503/timeout, probe)
    │   ├── groq.js                  # Groq client (timeout, 1 retry on 503/timeout, probe)
    │   └── index.js                 # Fallback chain, auto-pause on 3 failures, dynamic models
    ├── memory/
    │   ├── store.js                 # Message history, per-contact profiles, 30-day TTLs
    │   ├── summary.js               # Rolling conversation summary (every 20 messages)
    │   └── facts.js                 # Long-term contact fact extractor
    ├── whatsapp/
    │   ├── auth-store.js            # Baileys auth credentials in Upstash Redis (wa:* keys)
    │   ├── socket.js                # WASocket lifecycle, 20s watchdog, connection events
    │   ├── pairing.js               # Pairing code & QR generation with 15s reconnect retry
    │   └── handler.js               # Incoming message processing, human detection, auto-reply
    └── routes/
        ├── auth.js                  # POST /api/login, requireAuth middleware
        ├── state.js                 # GET /api/state
        ├── link.js                  # POST /api/link (pairing code request)
        ├── settings.js              # GET/POST /api/cfg, reconnect, logout, clear-memory
        ├── chats.js                 # GET /api/chats, /api/chats/:jid, takeover, resume
        ├── ai.js                    # POST /api/test-ai, GET /api/models
        └── system.js                # /health, /api/health, /api/stats, UI static serving
```

---

## Three-Tier Prompt Architecture

1. **Layer 1: Core Brain (Backend-Only, Immutable)**
   - Hardcoded in `server/brain/core-brain.js`.
   - Never stored in Redis, never returned or exposed by any API route.
   - Enforces assistant identity (*"JTech Assistant, an AI assistant for JTech"*), texting rules (short, warm, WhatsApp formatting `*bold*` / `_italic_`, max 1 emoji), uncertainty handling, and strict sensitive deferrals (money, passwords, calendar commitments, promises).
   - Enforces hierarchy: personal instructions cannot override safety, identity, or privacy rules.

2. **Layer 2: Personal Prompt (`settings.personalPrompt`)**
   - Editable in Settings under *"My instructions (how I want replies to sound)"*.
   - Stored in Redis (`config:personal_prompt`).
   - Automatically migrates legacy `config:base_rules` on first startup.

3. **Layer 3: Live Context Layer**
   - Live Africa/Freetown clock (`en-GB`, `Africa/Freetown`).
   - Contact profile (detected language: English / Krio, message length habit).
   - Known contact facts (extracted automatically).
   - Rolling conversation summary (updated every 20 messages).
   - Multi-turn conversation history (last 12 alternating turns).

---

## AI Models & Fallback Chain

- **Default Gemini**: `gemini-3.5-flash-lite`
- **Fallback Gemini**: `gemini-3.1-flash-lite`
- **Groq Primary**: `openai/gpt-oss-120b`
- **Resilience**: 15s timeout with 1 automatic retry on HTTP 503 or timeout, then seamless fallback to the secondary provider. Auto-pauses replies for 10 minutes if 3 consecutive dual-provider failures occur.

---

## Render Web Service Setup (Backend)

1. **Create Web Service**:
   - Connect repository to [Render](https://render.com).
   - Environment: **Node**
   - Build Command: `npm install`
   - Start Command: `node server.js`

2. **Environment Variables**:
   
   | Variable | Description |
   | :--- | :--- |
   | `DASHBOARD_PASSWORD` | Password for unlocking the dashboard via `POST /api/login` |
   | `UPSTASH_REDIS_REST_URL` | Upstash Redis REST URL (`https://...upstash.io`) |
   | `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST Token |
   | `GEMINI_API_KEY` | Google Gemini API Key |
   | `GROQ_API_KEY` | Groq API Key |
   | `ALLOWED_ORIGIN` | Allowed frontend origin for CORS (e.g. `https://<username>.github.io` or `*`) |
   | `RENDER_EXTERNAL_URL` | Optional: Your Render URL for automatic keep-awake self-pings |
   | `PORT` | Set automatically by Render (defaults to `3000`) |

---

## Linking WhatsApp

1. Open your dashboard in browser and sign in with `DASHBOARD_PASSWORD`.
2. Tap the center **Link** button in the bottom navigation.
3. Choose either:
   - **Pairing Code**: Enter phone number with country code (e.g. `23276123456`) and tap **Get pairing code**. Enter the 8-digit code in WhatsApp > Linked Devices > Link with phone number instead.
   - **QR Code**: Tap **Use QR code instead** to scan the live QR code with 60-second countdown.
