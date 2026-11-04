import express from 'express';
import { state } from '../state.js';
import { redis } from '../lib/redis.js';
import { logEvent } from '../lib/logger.js';
import {
  getChatMemory,
  jidToPhone,
  getResolvedContactName,
  normalizeJid,
  isChatPaused,
  pauseChat,
  resumeChat
} from '../memory/store.js';
import { requireAuth } from './auth.js';

const router = express.Router();

router.get('/chats', requireAuth, async (req, res) => {
  try {
    const recentRaw = await redis.get('chats:recent');
    let rawJids = [];
    if (recentRaw) {
      try { rawJids = JSON.parse(recentRaw); } catch (_) {}
    }

    // Deduplicate to canonical JIDs
    const canonicalJidSet = new Set();
    const orderedCanonicalJids = [];
    for (const raw of rawJids) {
      const canon = await normalizeJid(raw);
      if (canon && !canonicalJidSet.has(canon)) {
        canonicalJidSet.add(canon);
        orderedCanonicalJids.push(canon);
      }
    }

    const conversations = [];
    for (const jid of orderedCanonicalJids.slice(0, 30)) {
      try {
        const [metaRaw, handoffVal, settingsRaw, resolvedName, pauseInfo] = await Promise.all([
          redis.get(`chat:${jid}:meta`),
          redis.get(`handoff:${jid}`),
          redis.get(`contact:${jid}:settings`),
          getResolvedContactName(jid),
          isChatPaused(jid)
        ]);

        let isHandoff = false;
        if (handoffVal) {
          const until = parseInt(handoffVal, 10);
          isHandoff = isNaN(until) ? true : Date.now() < until;
        }

        let settings = null;
        if (settingsRaw) {
          try { settings = JSON.parse(settingsRaw); } catch (_) {}
        }

        let meta = null;
        if (metaRaw) {
          try { meta = JSON.parse(metaRaw); } catch (_) {}
        }

        const displayName = resolvedName || settings?.displayName || meta?.name || jidToPhone(jid) || jid;
        const relationship = settings?.relationship || 'acquaintance';
        const phone = jidToPhone(jid);

        conversations.push({
          jid,
          name: displayName,
          displayName,
          phone: phone ? `+${phone}` : '',
          relationship,
          lastMessage: meta?.lastMessage || '',
          lastRole: meta?.lastRole || 'user',
          lastFromMe: Boolean(meta?.fromMe || meta?.lastRole === 'assistant'),
          timestamp: meta?.timestamp || 0,
          needsOwner: Boolean(meta?.needsOwner),
          isHandoff,
          isPaused: Boolean(pauseInfo.isPaused),
          pauseUntil: pauseInfo.until || null,
          pauseMode: pauseInfo.mode || null
        });
      } catch (_) {}
    }

    res.json({ conversations });
  } catch (err) {
    res.status(500).json({
      error: err.message,
      code: 'CHATS_FETCH_FAILED',
      hint: 'Failed to retrieve active chat list.'
    });
  }
});

router.get('/chats/:jid/avatar', requireAuth, async (req, res) => {
  try {
    const rawJid = req.params.jid;
    if (!rawJid) return res.status(404).send('Not found');
    const jid = await normalizeJid(rawJid);

    const cacheKey = `wa:avatar:${jid}`;
    let url = await redis.get(cacheKey);

    if (!url && state.sock) {
      try {
        url = await state.sock.profilePictureUrl(jid, 'image');
        if (url) {
          await redis.set(cacheKey, url, { ex: 86400 });
        }
      } catch (_) {}
    }

    if (!url) {
      return res.status(404).send('No profile picture');
    }

    const imgRes = await fetch(url);
    if (!imgRes.ok) {
      return res.status(404).send('Image fetch failed');
    }

    const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    const arrayBuf = await imgRes.arrayBuffer();
    res.send(Buffer.from(arrayBuf));
  } catch (err) {
    res.status(404).send('Avatar not found');
  }
});

router.get('/chats/:jid', requireAuth, async (req, res) => {
  try {
    const rawJid = req.params.jid;
    const jid = await normalizeJid(rawJid);

    const [memory, metaRaw, settingsRaw, pauseInfo] = await Promise.all([
      getChatMemory(jid),
      redis.get(`chat:${jid}:meta`),
      redis.get(`contact:${jid}:settings`),
      isChatPaused(jid)
    ]);

    let meta = null;
    if (metaRaw) {
      try { meta = JSON.parse(metaRaw); } catch (_) {}
    }

    let settings = {
      displayName: '',
      relationship: 'acquaintance',
      prompt: '',
      updatedAt: 0
    };
    if (settingsRaw) {
      try { settings = { ...settings, ...JSON.parse(settingsRaw) }; } catch (_) {}
    }

    const displayName = settings.displayName || meta?.name || jidToPhone(jid) || jid;
    const phone = jidToPhone(jid);

    res.json({
      jid,
      meta,
      displayName,
      phone: phone ? `+${phone}` : '',
      relationship: settings.relationship,
      settings,
      needsOwner: Boolean(meta?.needsOwner),
      isHandoff: memory.isHandoff,
      isPaused: Boolean(pauseInfo.isPaused),
      pauseUntil: pauseInfo.until || null,
      pauseMode: pauseInfo.mode || null,
      summary: memory.summary,
      facts: memory.facts,
      profile: memory.profile,
      messages: memory.messages.slice(-35)
    });
  } catch (err) {
    res.status(500).json({
      error: err.message,
      code: 'CHAT_DETAIL_FAILED',
      hint: 'Failed to retrieve conversation details.'
    });
  }
});

router.get('/chats/:jid/settings', requireAuth, async (req, res) => {
  try {
    const rawJid = req.params.jid;
    const jid = await normalizeJid(rawJid);
    const raw = await redis.get(`contact:${jid}:settings`);
    let settings = {
      displayName: '',
      relationship: 'acquaintance',
      prompt: '',
      updatedAt: 0
    };
    if (raw) {
      try { settings = { ...settings, ...JSON.parse(raw) }; } catch (_) {}
    }
    res.json(settings);
  } catch (err) {
    res.status(500).json({
      error: err.message,
      code: 'CONTACT_SETTINGS_FETCH_FAILED',
      hint: 'Failed to retrieve contact settings.'
    });
  }
});

router.put('/chats/:jid/settings', requireAuth, async (req, res) => {
  try {
    const rawJid = req.params.jid;
    const jid = await normalizeJid(rawJid);
    const { displayName, relationship, prompt } = req.body || {};
    const cleanPrompt = String(prompt || '').slice(0, 1000);
    const cleanName = String(displayName || '').slice(0, 100).trim();
    const cleanRel = String(relationship || 'acquaintance').slice(0, 50).trim();

    const settingsObj = {
      displayName: cleanName,
      relationship: cleanRel,
      prompt: cleanPrompt,
      updatedAt: Date.now()
    };

    await redis.set(`contact:${jid}:settings`, JSON.stringify(settingsObj));

    if (cleanName) {
      const metaRaw = await redis.get(`chat:${jid}:meta`);
      if (metaRaw) {
        try {
          const meta = JSON.parse(metaRaw);
          meta.name = cleanName;
          await redis.set(`chat:${jid}:meta`, JSON.stringify(meta));
        } catch (_) {}
      }
    }

    logEvent('info', `Saved custom profile for ${jid} (${cleanName || 'unnamed'}, ${cleanRel})`);
    res.json({ success: true, settings: settingsObj });
  } catch (err) {
    res.status(500).json({
      error: err.message,
      code: 'CONTACT_SETTINGS_SAVE_FAILED',
      hint: 'Failed to save contact settings.'
    });
  }
});

// Per-Chat Pause & Resume Endpoints
router.post('/chats/:jid/pause', requireAuth, async (req, res) => {
  try {
    const rawJid = req.params.jid;
    const mode = req.body.mode || 'indefinite'; // 'indefinite' | '1h' | 'tomorrow'
    const result = await pauseChat(rawJid, mode);
    res.json({
      success: true,
      isPaused: true,
      mode: result.mode,
      until: result.until,
      message: `Chat paused (${mode}).`
    });
  } catch (err) {
    res.status(500).json({
      error: err.message,
      code: 'CHAT_PAUSE_FAILED',
      hint: 'Failed to pause chat in Redis.'
    });
  }
});

router.post('/chats/:jid/resume', requireAuth, async (req, res) => {
  try {
    const rawJid = req.params.jid;
    const jid = await normalizeJid(rawJid);
    await Promise.all([
      resumeChat(jid),
      redis.del(`handoff:${jid}`)
    ]);
    res.json({ success: true, isPaused: false, message: `Bot resumed for ${jid}.` });
  } catch (err) {
    res.status(500).json({
      error: err.message,
      code: 'CHAT_RESUME_FAILED',
      hint: 'Failed to resume chat.'
    });
  }
});

router.post('/chats/:jid/takeover', requireAuth, async (req, res) => {
  try {
    const rawJid = req.params.jid;
    const jid = await normalizeJid(rawJid);
    await redis.set(`handoff:${jid}`, 'manual_takeover');
    logEvent('info', `Human takeover activated for ${jid}`);
    res.json({ success: true, message: `Bot paused for ${jid}. Human takeover active.` });
  } catch (err) {
    res.status(500).json({
      error: err.message,
      code: 'TAKEOVER_FAILED',
      hint: 'Unable to update handoff status in Redis.'
    });
  }
});

router.post('/chats/:jid/resolve-owner', requireAuth, async (req, res) => {
  try {
    const rawJid = req.params.jid;
    const jid = await normalizeJid(rawJid);
    const metaRaw = await redis.get(`chat:${jid}:meta`);
    if (metaRaw) {
      try {
        const meta = JSON.parse(metaRaw);
        meta.needsOwner = false;
        await redis.set(`chat:${jid}:meta`, JSON.stringify(meta));
      } catch (_) {}
    }
    await redis.del(`contact:${jid}:needs_owner`);
    logEvent('info', `Owner attention marked resolved for ${jid}`);
    res.json({ success: true, message: 'Owner attention marked resolved' });
  } catch (err) {
    res.status(500).json({
      error: err.message,
      code: 'RESOLVE_OWNER_FAILED',
      hint: 'Unable to clear owner attention flag.'
    });
  }
});

export default router;
