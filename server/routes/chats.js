import express from 'express';
import { state } from '../state.js';
import { redis } from '../lib/redis.js';
import { logEvent } from '../lib/logger.js';
import { getChatMemory, jidToPhone, getResolvedContactName } from '../memory/store.js';
import { requireAuth } from './auth.js';

const router = express.Router();

router.get('/chats', requireAuth, async (req, res) => {
  try {
    const recentRaw = await redis.get('chats:recent');
    let jids = [];
    if (recentRaw) {
      try { jids = JSON.parse(recentRaw); } catch (_) {}
    }

    const conversations = [];
    for (const jid of jids.slice(0, 30)) {
      try {
        const [metaRaw, handoffVal, settingsRaw, resolvedName] = await Promise.all([
          redis.get(`chat:${jid}:meta`),
          redis.get(`handoff:${jid}`),
          redis.get(`contact:${jid}:settings`),
          getResolvedContactName(jid)
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
          isHandoff
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
    const { jid } = req.params;
    if (!jid) return res.status(404).send('Not found');

    const cacheKey = `wa:avatar:${jid}`;
    let url = await redis.get(cacheKey);

    if (!url && state.sock) {
      try {
        url = await state.sock.profilePictureUrl(jid, 'image');
        if (url) {
          await redis.set(cacheKey, url, { ex: 86400 }); // Cache for 24h
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
    const { jid } = req.params;
    const [memory, metaRaw, settingsRaw] = await Promise.all([
      getChatMemory(jid),
      redis.get(`chat:${jid}:meta`),
      redis.get(`contact:${jid}:settings`)
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
      summary: memory.summary,
      facts: memory.facts,
      profile: memory.profile,
      messages: memory.messages.slice(-12)
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
    const { jid } = req.params;
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
    const { jid } = req.params;
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

    // Sync displayName to meta and profile if provided
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


router.post('/chats/:jid/takeover', requireAuth, async (req, res) => {
  try {
    const { jid } = req.params;
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

router.post('/chats/:jid/resume', requireAuth, async (req, res) => {
  try {
    const { jid } = req.params;
    await redis.del(`handoff:${jid}`);
    logEvent('info', `Bot resumed for ${jid}`);
    res.json({ success: true, message: `Bot resumed for ${jid}.` });
  } catch (err) {
    res.status(500).json({
      error: err.message,
      code: 'RESUME_FAILED',
      hint: 'Unable to remove handoff status in Redis.'
    });
  }
});

router.post('/chats/:jid/resolve-owner', requireAuth, async (req, res) => {
  try {
    const { jid } = req.params;
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
