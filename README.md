# Personal WhatsApp AI Assistant

A high-performance, personal WhatsApp AI assistant with an intelligent prompt builder, voice-cloning capabilities, real-time memory with background summarization, and a standalone mobile-first web dashboard.

---

## Architecture & Features

- **Personal Voice & Identity**: Speaks authentically on your behalf in your personal tone, phrasing, and style. Includes sample message cloning, Freetown timezone awareness (`Africa/Freetown`), and English/Krio bilingual fluency.
- **Sensitive Topics Guardrail**: Politely deflects money requests, passwords/credentials, formal contracts/promises, and meeting requests, deferring them directly to you.
- **Human Direct Reply Detection**: If you reply to any contact directly on WhatsApp from your phone, the bot recognizes that you answered personally (by tracking bot-sent message IDs) and automatically silences itself for that contact for 10 minutes.
- **Intelligent Prompt Builder**: Rebuilt on every incoming message with 5 dynamic layers:
  1. Base rules and sensitive guardrails
  2. Owner profile (name, job, location, languages, bio, and 3 voice clone samples)
  3. Real-time Africa/Freetown clock
  4. Contact's learned facts (up to 10 stored per contact)
  5. Rolling chat summary (`sum:<jid>`, max 600 chars, refreshed every 20 messages)
- **12-Second AI Timeout & Automatic Fallback**: Primary provider (Google Gemini or Groq) with editable model names (`gemini-2.5-flash`, `llama-3.3-70b-versatile`). If one times out or errors, it immediately falls back to the other.
- **Auto-Pause**: If both providers fail 3 times consecutively, replies pause for 10 minutes with a dashboard alert.
- **Typing Indicator & Natural Delays**: Sends a WhatsApp composing indicator immediately, followed by a customizable random delay (default 300ms - 1200ms) before sending.
- **Baileys Linked Device**: Official 8-digit pairing code (no QR code needed). Automatically reconnects; if logged out, cleans `wa:*` keys from Redis.
- **Timing-Safe Dashboard Security**: Protected by `DASHBOARD_PASSWORD` via `x-pass` header using Node.js `crypto.timingSafeEqual`.
- **Uptime Route**: Tiny public `/health` endpoint for Render uptime pingers (prevents free plan spin-down).

---

## Step-by-Step Setup Guide

### 1. Upstash Redis Setup (Free)
1. Go to [Upstash](https://console.upstash.com) and create a free account.
2. Click **Create Database**.
3. Choose a region close to your Render deployment.
4. Once created, scroll down to the **REST API** section.
5. Copy two values:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`

### 2. AI API Keys
- **Google Gemini**: Get an API key from [Google AI Studio](https://aistudio.google.com/apikey).
- **Groq**: Get a free API key from [Groq Console](https://console.groq.com/keys).

### 3. GitHub Repository Setup
1. Initialize git in your project directory (if not already done):
   ```bash
   git init
   git add package.json server.js ui.html README.md .gitignore
   git commit -m "Initial commit: Personal WhatsApp AI Assistant"
   ```
2. Create a new **Private Repository** on GitHub.
3. Push your code to GitHub:
   ```bash
   git remote add origin https://github.com/<your-username>/<your-repo-name>.git
   git branch -M main
   git push -u origin main
   ```

### 4. Deploying to Render (Free Web Service)
1. Log in to [Render](https://dashboard.render.com).
2. Click **New +** > **Web Service**.
3. Connect your GitHub repository.
4. Fill in the service configuration:
   - **Name**: `personal-whatsapp-assistant`
   - **Region**: Oregon or Frankfurt
   - **Branch**: `main`
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Instance Type**: `Free`
5. In the **Environment Variables** section, add:
   - `PHONE_NUMBER`: Your WhatsApp number with country code, digits only (e.g., `23276123456`)
   - `DASHBOARD_PASSWORD`: A secure secret passphrase to unlock your dashboard (e.g., `freetown_assistant_2026`)
   - `UPSTASH_REDIS_REST_URL`: Your Upstash Redis REST URL
   - `UPSTASH_REDIS_REST_TOKEN`: Your Upstash Redis REST Token
   - `GEMINI_API_KEY`: Your Google Gemini API Key
   - `GROQ_API_KEY`: Your Groq API Key
6. Click **Create Web Service**.

### 5. Keeping Render Awake (Prevent Free Tier Sleep)
Render free web services spin down after 15 minutes of inactivity. Use a free external pinger like [UptimeRobot](https://uptimerobot.com) or [Cron-Job.org]:
- Add a new HTTP monitor pointing to: `https://<your-render-app-name>.onrender.com/health`
- Set the check interval to every **5 minutes**.

### 6. WhatsApp Pairing Flow
1. Open your Render app URL in your mobile or desktop browser (e.g. `https://<your-render-app>.onrender.com`).
2. Unlock using your `DASHBOARD_PASSWORD`.
3. Go to the **Link device** tab.
4. Enter your phone number with country code (e.g. `23276123456`) and click **Generate pairing code**.
5. On your phone: Open WhatsApp > **Settings** > **Linked Devices** > **Link a Device** > **Link with phone number instead**.
6. Enter the 8-digit code displayed on your dashboard.
7. You are connected! The status indicator turns green (`open`).

---

## Dashboard Usage

- **Owner Profile**: Customize your name, location, profession, languages, and 3 voice clone sample messages.
- **Live Chat Viewer**: Review the 30 latest chats, tap any conversation to see the last 12 messages, view extracted facts, and use **Take over** or **Resume bot**.
- **Contact Rules**: Toggle between `Reply to everyone`, `Only allowlist`, or `Everyone except blocklist`. Supports both `@lid` IDs and phone numbers.
- **AI Switch**: Switch between Gemini and Groq, change model names, adjust typing delay ranges, or activate the global pause switch.
