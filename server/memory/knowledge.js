import { redis } from '../lib/redis.js';
import { logEvent } from '../lib/logger.js';
import { state } from '../state.js';
import { getSettings } from '../lib/settings.js';
import { runAiCompletion } from '../ai/index.js';
import { dispatchPacedReply, DEFAULT_PACING_SETTINGS } from '../whatsapp/pacing.js';

/**
 * Record a question the assistant did not know into the Teach-Me inbox.
 * Semantically deduplicates against existing pending questions.
 */
export async function recordTeachMeItem({ contactJid, contactName, originalMessage, question }) {
  if (!question || !question.trim()) return;

  const cleanQuestion = question.trim();
  const normalizedNew = cleanQuestion.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const newWords = new Set(normalizedNew.split(' ').filter(w => w.length > 2));

  try {
    const existingItems = await getPendingTeachMe();
    
    // Check for exact or high word-overlap match among pending items
    let matchedItem = null;
    for (const pending of existingItems) {
      const normalizedExisting = (pending.question || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
      if (normalizedNew === normalizedExisting) {
        matchedItem = pending;
        break;
      }
      
      const existingWords = new Set(normalizedExisting.split(' ').filter(w => w.length > 2));
      if (newWords.size > 0 && existingWords.size > 0) {
        let intersection = 0;
        for (const w of newWords) {
          if (existingWords.has(w)) intersection++;
        }
        const union = new Set([...newWords, ...existingWords]).size;
        const jaccard = union > 0 ? intersection / union : 0;
        if (jaccard >= 0.6) {
          matchedItem = pending;
          break;
        }
      }
    }

    if (matchedItem) {
      // Increment count on existing card
      matchedItem.askCount = (matchedItem.askCount || 1) + 1;
      matchedItem.lastAskedAt = Date.now();
      if (!Array.isArray(matchedItem.askers)) {
        matchedItem.askers = [{
          contactJid: matchedItem.contactJid,
          contactName: matchedItem.contactName,
          askedAt: matchedItem.askedAt,
          originalMessage: matchedItem.originalMessage
        }];
      }
      matchedItem.askers.push({
        contactJid: contactJid || '',
        contactName: contactName || contactJid || 'Contact',
        askedAt: Date.now(),
        originalMessage: (originalMessage || '').slice(0, 300)
      });
      // Update most recent asker for quick reference
      matchedItem.contactJid = contactJid || matchedItem.contactJid;
      matchedItem.contactName = contactName || matchedItem.contactName;
      matchedItem.originalMessage = (originalMessage || '').slice(0, 300) || matchedItem.originalMessage;

      await redis.hset('teachme:items', matchedItem.id, JSON.stringify(matchedItem));
      logEvent('info', `Updated question in Teach-Me (Asked ${matchedItem.askCount} times): "${matchedItem.question}"`);
      return matchedItem;
    }

    // New question card
    const id = `tm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const item = {
      id,
      contactJid: contactJid || '',
      contactName: contactName || contactJid || 'Contact',
      originalMessage: (originalMessage || '').slice(0, 300),
      question: cleanQuestion,
      askedAt: Date.now(),
      lastAskedAt: Date.now(),
      askCount: 1,
      askers: [{
        contactJid: contactJid || '',
        contactName: contactName || contactJid || 'Contact',
        askedAt: Date.now(),
        originalMessage: (originalMessage || '').slice(0, 300)
      }],
      status: 'pending'
    };

    await redis.hset('teachme:items', id, JSON.stringify(item));
    logEvent('info', `Added question to Teach-Me inbox from ${item.contactName}: "${item.question}"`);
    return item;
  } catch (err) {
    console.warn('[Knowledge] Error recording teach-me item:', err.message);
  }
}

/**
 * Get all pending Teach-Me questions, newest first
 */
export async function getPendingTeachMe() {
  try {
    const all = await redis.hgetall('teachme:items');
    if (!all) return [];

    const items = [];
    for (const val of Object.values(all)) {
      try {
        const parsed = JSON.parse(val);
        if (parsed.status === 'pending') {
          items.push(parsed);
        }
      } catch (_) {}
    }

    items.sort((a, b) => (b.askedAt || 0) - (a.askedAt || 0));
    return items;
  } catch (err) {
    console.warn('[Knowledge] Error fetching pending teach-me items:', err.message);
    return [];
  }
}

/**
 * Dismiss a Teach-Me question without saving it to knowledge
 */
export async function dismissTeachMeItem(id) {
  if (!id) return;
  try {
    await redis.hdel('teachme:items', id);
    logEvent('info', `Dismissed Teach-Me item ${id}`);
    return true;
  } catch (err) {
    console.warn('[Knowledge] Error dismissing teach-me item:', err.message);
    return false;
  }
}

/**
 * Answer a Teach-Me question:
 * 1. Saves it into the persistent Knowledge Base (Redis)
 * 2. Removes it from pending Teach-Me
 * 3. Optionally generates a natural reply and sends it to the contact on WhatsApp
 */
export async function answerTeachMeItem(id, { answer, scope = 'everyone', sendToContact = false }) {
  if (!id || !answer) throw new Error('Missing ID or answer text');

  const rawItem = await redis.hget('teachme:items', id);
  if (!rawItem) throw new Error('Teach-Me item not found');

  const item = JSON.parse(rawItem);
  const cleanAnswer = answer.trim();

  // Create Knowledge Base entry
  const kId = `k_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const knowledgeItem = {
    id: kId,
    question: item.question,
    answer: cleanAnswer,
    scope: scope === 'this contact' ? 'this contact' : 'everyone',
    contactJid: scope === 'this contact' ? item.contactJid : '',
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  await redis.hset('knowledge:items', kId, JSON.stringify(knowledgeItem));
  await redis.hdel('teachme:items', id);
  logEvent('info', `Knowledge item added from Teach-Me: "${knowledgeItem.question}" (Scope: ${knowledgeItem.scope})`);

  // Optionally send answer directly to the contact on WhatsApp
  if (sendToContact && item.contactJid && state.sock) {
    try {
      const settings = await getSettings();
      const pacing = settings.pacing || DEFAULT_PACING_SETTINGS;
      const ownerName = settings.identity?.ownerName || settings.profile?.ownerName || 'JTech';

      const prompt = `
You are the personal assistant for ${ownerName}.
Earlier, the contact "${item.contactName}" asked:
"${item.originalMessage || item.question}"

The owner just provided this confirmed answer:
"${cleanAnswer}"

Write a warm, concise WhatsApp reply (1 to 2 short sentences, max 3) to the contact relaying this answer.
Tone: Natural, respectful, texting as the owner's assistant who checked and got the answer for them.
Do not use bullet points or markdown headers. Do NOT include any control markers like [UNKNOWN].
`.trim();

      const replyText = await runAiCompletion(prompt, 'You are an executive personal assistant texting on WhatsApp.');

      if (replyText && replyText.trim()) {
        const senderLabel = settings.profile?.ownerName ? `${settings.profile.ownerName} (AI)` : 'You';
        await dispatchPacedReply({
          sock: state.sock,
          senderJid: item.contactJid,
          rawReplyText: replyText.trim(),
          lastMsg: null,
          pacing,
          senderLabel,
          hourKey: new Date().toISOString().slice(0, 13)
        });
        logEvent('info', `Sent answered Teach-Me reply to ${item.contactJid}`);
      }
    } catch (sendErr) {
      logEvent('warn', `Failed to send answered Teach-Me reply to ${item.contactJid}: ${sendErr.message}`);
    }
  }

  return { success: true, knowledgeItem };
}

/**
 * List all knowledge items
 */
export async function listKnowledge() {
  try {
    const all = await redis.hgetall('knowledge:items');
    if (!all) return [];

    const items = [];
    for (const val of Object.values(all)) {
      try { items.push(JSON.parse(val)); } catch (_) {}
    }

    items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return items;
  } catch (err) {
    console.warn('[Knowledge] Error listing knowledge:', err.message);
    return [];
  }
}

/**
 * Add a new knowledge item directly
 */
export async function addKnowledgeItem({ question, answer, scope = 'everyone', contactJid = '' }) {
  if (!question || !answer) throw new Error('Question and answer are required');

  const id = `k_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const item = {
    id,
    question: question.trim(),
    answer: answer.trim(),
    scope: scope === 'this contact' ? 'this contact' : 'everyone',
    contactJid: scope === 'this contact' ? (contactJid || '') : '',
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  await redis.hset('knowledge:items', id, JSON.stringify(item));
  logEvent('info', `Added knowledge base item: "${item.question}"`);
  return item;
}

/**
 * Update an existing knowledge item
 */
export async function updateKnowledgeItem(id, { question, answer, scope, contactJid }) {
  if (!id) throw new Error('ID is required');

  const raw = await redis.hget('knowledge:items', id);
  if (!raw) throw new Error('Knowledge item not found');

  const item = JSON.parse(raw);
  if (question !== undefined) item.question = question.trim();
  if (answer !== undefined) item.answer = answer.trim();
  if (scope !== undefined) item.scope = scope === 'this contact' ? 'this contact' : 'everyone';
  if (contactJid !== undefined) item.contactJid = contactJid;
  item.updatedAt = Date.now();

  await redis.hset('knowledge:items', id, JSON.stringify(item));
  logEvent('info', `Updated knowledge base item ${id}`);
  return item;
}

/**
 * Delete a knowledge item
 */
export async function deleteKnowledgeItem(id) {
  if (!id) return;
  try {
    await redis.hdel('knowledge:items', id);
    logEvent('info', `Deleted knowledge item ${id}`);
    return true;
  } catch (err) {
    console.warn('[Knowledge] Error deleting knowledge item:', err.message);
    return false;
  }
}

/**
 * Get formatted knowledge text for prompt injection (relevant items only, newest first)
 */
export async function getKnowledgeForPrompt(senderJid = '') {
  try {
    const all = await listKnowledge();
    if (all.length === 0) return '';

    // Filter by scope: "everyone" or "this contact" matching senderJid
    const relevant = all.filter(item => {
      if (item.scope === 'everyone') return true;
      if (item.scope === 'this contact' && senderJid && item.contactJid === senderJid) return true;
      return false;
    });

    if (relevant.length === 0) return '';

    // Keep top 15 newest items to stay well within token budget
    const sliced = relevant.slice(0, 15);

    const lines = sliced.map(k => `- Question: ${k.question}\n  Confirmed Fact: ${k.answer}`);

    return `
=== OWNER KNOWLEDGE BASE (VERIFIED FACTS) ===
(Use these confirmed facts to answer questions accurately. Never reveal private movements or sensitive schedule details unless explicitly stated here.)
${lines.join('\n\n')}
`.trim();
  } catch (err) {
    console.warn('[Knowledge] Error building knowledge prompt:', err.message);
    return '';
  }
}
