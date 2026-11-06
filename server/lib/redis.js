import { Redis } from '@upstash/redis';
import { UPSTASH_URL, UPSTASH_TOKEN } from '../config.js';
import { logEvent } from './logger.js';

export class UpstashStore {
  constructor() {
    this.isUpstash = Boolean(UPSTASH_URL && UPSTASH_TOKEN && !UPSTASH_URL.includes('your-database'));
    if (this.isUpstash) {
      try {
        this.client = new Redis({
          url: UPSTASH_URL,
          token: UPSTASH_TOKEN,
          automaticDeserialization: false
        });
        logEvent('info', 'Connected to Upstash Redis REST (automaticDeserialization: false)');
      } catch (err) {
        logEvent('error', `Upstash init error, falling back to local memory store: ${err.message}`);
        this.client = null;
        this.isUpstash = false;
      }
    } else {
      logEvent('warn', 'No valid UPSTASH_REDIS_REST_URL / TOKEN. Running with in-memory store.');
      this.client = null;
    }
    this.memory = new Map();
    this.hashes = new Map(); // in-memory fallback for hash keys
    this.sets = new Map();   // in-memory fallback for set keys
  }

  async ping() {
    try {
      if (this.isUpstash && this.client) {
        await this.client.get('__ping__');
        return 'ok';
      }
      return this.isUpstash ? 'error' : 'ok';
    } catch (_) {
      return 'error';
    }
  }

  async get(key) {
    try {
      if (this.isUpstash && this.client) {
        const val = await this.client.get(key);
        return val === null ? null : String(val);
      }
    } catch (e) {
      console.error(`[Redis] GET error for ${key}:`, e.message);
    }
    return this.memory.has(key) ? this.memory.get(key) : null;
  }

  async set(key, value, options = {}) {
    try {
      const strVal = typeof value === 'string' ? value : JSON.stringify(value);
      if (this.isUpstash && this.client) {
        if (options.ex) {
          await this.client.set(key, strVal, { ex: options.ex });
        } else {
          await this.client.set(key, strVal);
        }
        return 'OK';
      }
      this.memory.set(key, strVal);
      return 'OK';
    } catch (e) {
      console.error(`[Redis] SET error for ${key}:`, e.message);
      this.memory.set(key, String(value));
      return 'OK';
    }
  }

  async del(...keys) {
    keys = keys.flat().filter(Boolean);
    if (keys.length === 0) return 0;
    try {
      if (this.isUpstash && this.client) {
        await this.client.del(...keys);
      }
    } catch (e) {
      console.error(`[Redis] DEL error for ${keys.length} key(s):`, e.message);
    }
    for (const key of keys) {
      this.memory.delete(key);
      this.hashes.delete(key);
      this.sets.delete(key);
    }
    return keys.length;
  }

  async expire(key, seconds) {
    try {
      if (this.isUpstash && this.client) {
        return await this.client.expire(key, seconds);
      }
    } catch (e) {
      console.error(`[Redis] EXPIRE error for ${key}:`, e.message);
    }
    return 1;
  }

  async incr(key) {
    try {
      if (this.isUpstash && this.client) {
        return await this.client.incr(key);
      }
    } catch (e) {
      console.error(`[Redis] INCR error for ${key}:`, e.message);
    }
    const current = parseInt(this.memory.get(key) || '0', 10);
    const next = current + 1;
    this.memory.set(key, String(next));
    return next;
  }

  async lpush(key, value) {
    const strVal = typeof value === 'string' ? value : JSON.stringify(value);
    try {
      if (this.isUpstash && this.client) {
        return await this.client.lpush(key, strVal);
      }
    } catch (e) {
      console.error(`[Redis] LPUSH error for ${key}:`, e.message);
    }
    const list = this.getMemoryList(key);
    list.unshift(strVal);
    this.memory.set(key, JSON.stringify(list));
    return list.length;
  }

  async rpush(key, value) {
    const strVal = typeof value === 'string' ? value : JSON.stringify(value);
    try {
      if (this.isUpstash && this.client) {
        return await this.client.rpush(key, strVal);
      }
    } catch (e) {
      console.error(`[Redis] RPUSH error for ${key}:`, e.message);
    }
    const list = this.getMemoryList(key);
    list.push(strVal);
    this.memory.set(key, JSON.stringify(list));
    return list.length;
  }

  async lrange(key, start, stop) {
    try {
      if (this.isUpstash && this.client) {
        const res = await this.client.lrange(key, start, stop);
        if (Array.isArray(res)) return res.map(String);
      }
    } catch (e) {
      console.error(`[Redis] LRANGE error for ${key}:`, e.message);
    }
    const list = this.getMemoryList(key);
    const len = list.length;
    let s = start < 0 ? Math.max(0, len + start) : start;
    let e = stop < 0 ? Math.max(0, len + stop) : stop;
    return list.slice(s, e + 1);
  }

  async ltrim(key, start, stop) {
    try {
      if (this.isUpstash && this.client) {
        return await this.client.ltrim(key, start, stop);
      }
    } catch (e) {
      console.error(`[Redis] LTRIM error for ${key}:`, e.message);
    }
    const list = this.getMemoryList(key);
    const len = list.length;
    let s = start < 0 ? Math.max(0, len + start) : start;
    let e = stop < 0 ? Math.max(0, len + stop) : stop;
    const trimmed = list.slice(s, e + 1);
    this.memory.set(key, JSON.stringify(trimmed));
    return 'OK';
  }

  // ---------- Hashes ----------
  async hset(key, fieldOrObject, value) {
    const obj = (fieldOrObject && typeof fieldOrObject === 'object')
      ? fieldOrObject
      : { [fieldOrObject]: value };
    const data = {};
    for (const [f, v] of Object.entries(obj)) {
      data[f] = typeof v === 'string' ? v : JSON.stringify(v);
    }
    try {
      if (this.isUpstash && this.client) {
        await this.client.hset(key, data);
        return Object.keys(data).length;
      }
    } catch (e) {
      console.error(`[Redis] HSET error for ${key}:`, e.message);
    }
    const h = this.hashes.get(key) || new Map();
    for (const [f, v] of Object.entries(data)) h.set(f, v);
    this.hashes.set(key, h);
    return Object.keys(data).length;
  }

  async hget(key, field) {
    try {
      if (this.isUpstash && this.client) {
        const val = await this.client.hget(key, field);
        return val === null || val === undefined ? null : (typeof val === 'string' ? val : JSON.stringify(val));
      }
    } catch (e) {
      console.error(`[Redis] HGET error for ${key}:`, e.message);
    }
    const h = this.hashes.get(key);
    return h && h.has(field) ? h.get(field) : null;
  }

  async hgetall(key) {
    try {
      if (this.isUpstash && this.client) {
        const res = await this.client.hgetall(key);
        if (!res || Object.keys(res).length === 0) return null;
        const out = {};
        for (const [f, v] of Object.entries(res)) {
          out[f] = typeof v === 'string' ? v : JSON.stringify(v);
        }
        return out;
      }
    } catch (e) {
      console.error(`[Redis] HGETALL error for ${key}:`, e.message);
    }
    const h = this.hashes.get(key);
    if (!h || h.size === 0) return null;
    return Object.fromEntries(h);
  }

  async hdel(key, ...fields) {
    fields = fields.flat().filter(f => f !== undefined && f !== null);
    if (fields.length === 0) return 0;
    try {
      if (this.isUpstash && this.client) {
        return await this.client.hdel(key, ...fields);
      }
    } catch (e) {
      console.error(`[Redis] HDEL error for ${key}:`, e.message);
    }
    const h = this.hashes.get(key);
    if (!h) return 0;
    let removed = 0;
    for (const f of fields) if (h.delete(f)) removed++;
    if (h.size === 0) this.hashes.delete(key);
    return removed;
  }

  // ---------- Sets ----------
  async sadd(key, ...members) {
    members = members.flat().filter(m => m !== undefined && m !== null).map(String);
    if (members.length === 0) return 0;
    try {
      if (this.isUpstash && this.client) {
        return await this.client.sadd(key, members[0], ...members.slice(1));
      }
    } catch (e) {
      console.error(`[Redis] SADD error for ${key}:`, e.message);
    }
    const set = this.sets.get(key) || new Set();
    let added = 0;
    for (const m of members) if (!set.has(m)) { set.add(m); added++; }
    this.sets.set(key, set);
    return added;
  }

  async srem(key, ...members) {
    members = members.flat().filter(m => m !== undefined && m !== null).map(String);
    if (members.length === 0) return 0;
    try {
      if (this.isUpstash && this.client) {
        return await this.client.srem(key, ...members);
      }
    } catch (e) {
      console.error(`[Redis] SREM error for ${key}:`, e.message);
    }
    const set = this.sets.get(key);
    if (!set) return 0;
    let removed = 0;
    for (const m of members) if (set.delete(m)) removed++;
    if (set.size === 0) this.sets.delete(key);
    return removed;
  }

  async smembers(key) {
    try {
      if (this.isUpstash && this.client) {
        const res = await this.client.smembers(key);
        return Array.isArray(res) ? res.map(String) : [];
      }
    } catch (e) {
      console.error(`[Redis] SMEMBERS error for ${key}:`, e.message);
    }
    const set = this.sets.get(key);
    return set ? Array.from(set) : [];
  }

  // ---------- Key search ----------
  async keys(pattern = '*') {
    try {
      if (this.isUpstash && this.client) {
        const res = await this.client.keys(pattern);
        return Array.isArray(res) ? res.map(String) : [];
      }
    } catch (e) {
      console.error(`[Redis] KEYS error for ${pattern}:`, e.message);
    }
    return this.matchMemoryKeys(pattern);
  }

  async scan(cursor = '0', options = {}) {
    try {
      if (this.isUpstash && this.client) {
        const res = await this.client.scan(cursor, options);
        const next = String(res[0]);
        const found = Array.isArray(res[1]) ? res[1].map(String) : [];
        return [next, found];
      }
    } catch (e) {
      console.error(`[Redis] SCAN error:`, e.message);
      return ['0', []];
    }
    return ['0', this.matchMemoryKeys(options.match || '*')];
  }

  matchMemoryKeys(pattern) {
    const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    const re = new RegExp('^' + escaped + '$');
    const all = new Set([...this.memory.keys(), ...this.hashes.keys(), ...this.sets.keys()]);
    return Array.from(all).filter(k => re.test(k));
  }

  getMemoryList(key) {
    try {
      const raw = this.memory.get(key);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch (_) {}
    return [];
  }
}

export const redis = new UpstashStore();
