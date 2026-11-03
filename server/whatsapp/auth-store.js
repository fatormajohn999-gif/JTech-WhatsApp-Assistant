import { BufferJSON, initAuthCreds } from '@whiskeysockets/baileys';
import { redis } from '../lib/redis.js';
import { logEvent } from '../lib/logger.js';

export async function useUpstashAuthState() {
  let creds;
  try {
    const rawCreds = await redis.get('wa:creds');
    if (rawCreds) {
      creds = JSON.parse(rawCreds, BufferJSON.reviver);
    }
  } catch (err) {
    logEvent('warn', `Failed to parse wa:creds, initializing fresh creds: ${err.message}`);
  }

  if (!creds) {
    creds = initAuthCreds();
  }

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              try {
                const keyName = `wa:keys:${type}:${id}`;
                const raw = await redis.get(keyName);
                if (raw) {
                  data[id] = JSON.parse(raw, BufferJSON.reviver);
                }
              } catch (e) {
                console.error(`[Auth] Error fetching key ${type}:${id}:`, e.message);
              }
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const keyName = `wa:keys:${category}:${id}`;
              if (value) {
                const str = JSON.stringify(value, BufferJSON.replacer);
                tasks.push(redis.set(keyName, str));
              } else {
                tasks.push(redis.del(keyName));
              }
            }
          }
          await Promise.all(tasks);
        }
      }
    },
    saveCreds: async () => {
      try {
        const serialized = JSON.stringify(creds, BufferJSON.replacer);
        await redis.set('wa:creds', serialized);
      } catch (err) {
        logEvent('error', `Failed to save wa:creds: ${err.message}`);
      }
    }
  };
}

export async function clearWhatsAppAuth() {
  try {
    await redis.del('wa:creds');
    // FIX: also wipe every stored signal key (wa:keys:*). Old keys left next to
    // brand-new creds corrupt the next pairing attempt.
    let cursor = '0';
    let removed = 0;
    do {
      const result = await redis.scan(cursor, { match: 'wa:keys:*', count: 200 });
      cursor = String(result[0]);
      const keys = result[1] || [];
      if (keys.length > 0) {
        await redis.del(...keys);
        removed += keys.length;
      }
    } while (cursor !== '0');
    logEvent('info', `Cleared wa:creds and ${removed} wa:keys:* entries from Redis`);
  } catch (e) {
    logEvent('error', `Error clearing WhatsApp auth: ${e.message}`);
  }
}
