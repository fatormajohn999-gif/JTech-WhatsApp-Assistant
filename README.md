# JTech Assistant

A high-performance personal WhatsApp AI assistant for **JTech** with a mobile-first app experience (iOS/Android native feel, TikTok-style bottom navigation, hash routing, 100dvh safe-area support), intelligent prompt builder, live chat viewer, and real-time Redis memory.

---

## Architecture

- **Backend**: Node 20+, Express, `@whiskeysockets/baileys` (pairing code login, no QR), `@upstash/redis` REST (`automaticDeserialization: false`), dual AI providers (Google Gemini & Groq fallback). Hosted as a Render Web Service.
- **Frontend Dashboard**: Self-contained mobile-first web app with Bearer token authentication, hash routing (`#home`, `#chats`, `#link`, `#dashboard`, `#settings`), and live polling. Deployed to **GitHub Pages** with build-time `VITE_API_URL`.

---

## GitHub Pages Setup (Frontend)

1. **Repository Settings**:
   - Go to your repository on GitHub.
   - Navigate to **Settings** > **Pages**.
   - Under **Build and deployment**, set **Source** to **GitHub Actions**.

2. **Configure `VITE_API_URL` Variable**:
   - In your repository, go to **Settings** > **Secrets and variables** > **Actions** > **Variables** tab.
   - Click **New repository variable**.
   - **Name**: `VITE_API_URL`
   - **Value**: Your deployed Render backend URL (e.g. `https://jtech-assistant.onrender.com` without trailing slash).
   - Click **Add variable**.

3. **Deploy**:
   - Push to `main`. The included `.github/workflows/deploy.yml` will automatically build with Vite (`base: "./"`) and deploy to GitHub Pages.
   - If `VITE_API_URL` is ever missing, the frontend displays a clear configuration guide with a manual session connection option.

---

## Render Web Service Setup (Backend)

1. **Create Web Service**:
   - Connect your GitHub repository to [Render](https://render.com).
   - Environment: **Node**
   - Build Command: `npm install`
   - Start Command: `node server.js`

2. **Backend Environment Secrets**:
   Configure these in Render > **Environment**:
   
   | Variable | Description |
   | :--- | :--- |
   | `DASHBOARD_PASSWORD` | Secure password for unlocking the dashboard via `POST /api/login` |
   | `UPSTASH_REDIS_REST_URL` | Upstash Redis REST URL (`https://...upstash.io`) |
   | `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST Token |
   | `GEMINI_API_KEY` | Google Gemini API Key |
   | `GROQ_API_KEY` | Groq API Key |
   | `PORT` | Set automatically by Render (defaults to `3000`) |

   *Note: The frontend never contains or asks for any API keys. Secrets live strictly on the backend.*

3. **Keep Awake**:
   - Point an uptime monitor (e.g. [UptimeRobot](https://uptimerobot.com)) to `https://<your-service>.onrender.com/health` every 5 minutes.

---

## Linking WhatsApp

1. Open your GitHub Pages or Render dashboard URL.
2. Sign in using your `DASHBOARD_PASSWORD`.
3. Tap the center **Link** button in the bottom navigation.
4. Enter your phone number with country code (digits only, e.g. `23276123456`).
5. Tap **Get pairing code** to receive your 8-digit code.
6. Open **WhatsApp** on your phone > **Settings** > **Linked devices** > **Link a device** > **Link with phone number instead** and enter the code.
7. The status pill will change to **Connected** automatically.
