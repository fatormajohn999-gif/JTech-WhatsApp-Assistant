import { redis } from './redis.js';
import { GEMINI_API_KEY, GROQ_API_KEY } from '../config.js';

export function maskApiKey(key) {
  if (!key || typeof key !== 'string') return null;
  const trimmed = key.trim();
  if (!trimmed) return null;
  if (trimmed.length <= 4) return '...***';
  return '...' + trimmed.slice(-4);
}

export async function getEffectiveApiKey(provider) {
  const norm = String(provider || '').toLowerCase();
  if (norm === 'gemini') {
    try {
      const stored = await redis.get('config:api_key:gemini');
      if (stored && typeof stored === 'string' && stored.trim()) {
        return stored.trim();
      }
    } catch (_) {}
    return (process.env.GEMINI_API_KEY || GEMINI_API_KEY || '').trim();
  }

  if (norm === 'groq') {
    try {
      const stored = await redis.get('config:api_key:groq');
      if (stored && typeof stored === 'string' && stored.trim()) {
        return stored.trim();
      }
    } catch (_) {}
    return (process.env.GROQ_API_KEY || GROQ_API_KEY || '').trim();
  }

  return '';
}

export async function setEffectiveApiKey(provider, rawKey) {
  const norm = String(provider || '').toLowerCase();
  if (norm !== 'gemini' && norm !== 'groq') return false;

  if (rawKey === null || rawKey === undefined) return false;
  const trimmed = String(rawKey).trim();

  // If user passed a masked string like "...1234", ignore so we never overwrite with a masked representation
  if (trimmed.startsWith('...')) {
    return false;
  }

  if (trimmed === '') {
    await redis.del(`config:api_key:${norm}`);
    return true;
  }

  await redis.set(`config:api_key:${norm}`, trimmed);
  return true;
}

export async function getApiKeysStatus() {
  const [geminiKey, groqKey] = await Promise.all([
    getEffectiveApiKey('gemini'),
    getEffectiveApiKey('groq')
  ]);

  return {
    gemini: {
      configured: Boolean(geminiKey),
      masked: maskApiKey(geminiKey)
    },
    groq: {
      configured: Boolean(groqKey),
      masked: maskApiKey(groqKey)
    }
  };
}
