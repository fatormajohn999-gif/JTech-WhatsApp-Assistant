import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const ROOT_DIR = path.resolve(__dirname, '..');

export const PORT = parseInt(process.env.PORT || '3000', 10);
export const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
export const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
export const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || '';
export const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || '';
export const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
export const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
export const GROQ_API_KEY = process.env.GROQ_API_KEY || '';

// Default and fallback AI models
export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';
export const FALLBACK_GEMINI_MODEL = 'gemini-3.1-flash-lite';
export const DEFAULT_GROQ_MODEL = 'openai/gpt-oss-120b';

// Timeouts and TTLs
export const CONTACT_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
export const SETTINGS_CACHE_TTL = 30 * 1000;          // 30 seconds
export const MODELS_CACHE_TTL = 10 * 60 * 1000;       // 10 minutes
export const AI_CALL_TIMEOUT_MS = 15000;              // 15 seconds

export const DEFAULT_PROFILE = {
  ownerName: 'JTech',
  ownerFirstName: '',
  ownerAbout: 'Leading tech brand and software solutions in Freetown, Sierra Leone. Dedicated to building innovative software, web, and mobile solutions.',
  ownerLanguages: 'English, Krio',
  writingStyle: 'Short, warm, natural, respectful, and direct. Sounds like a real person texting.',
  name: 'JTech',
  timeZone: 'Africa/Freetown',
  job: 'Tech Company & Software Solutions',
  languages: 'English, Krio',
  facts: 'Technology provider based in Freetown, Sierra Leone. Builds software, web, and AI solutions.'
};

export const DEFAULT_PERSONAL_PROMPT = 
`Sound like a real person texting on WhatsApp: short, warm, and natural.
Match the sender's language, dialect (English or Krio), and message length.
Do not repeat opening or closing phrases. Avoid robotic jargon.
Keep replies concise and friendly.`;

if (!DASHBOARD_PASSWORD) {
  console.error('****************************************************************');
  console.error(' [SECURITY WARNING] DASHBOARD_PASSWORD environment variable is NOT set!');
  console.error(' All dashboard logins and password-protected API routes will be refused.');
  console.error(' Set DASHBOARD_PASSWORD in your environment before using the dashboard.');
  console.error('****************************************************************');
}
