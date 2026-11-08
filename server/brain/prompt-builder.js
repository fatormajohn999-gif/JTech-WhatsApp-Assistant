import { CORE_BRAIN } from './core-brain.js';

export function getFreetownTime() {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Africa/Freetown',
      dateStyle: 'full',
      timeStyle: 'medium'
    }).format(new Date());
  } catch (_) {
    return new Date().toUTCString();
  }
}

export function formatLastSeen(lastSeenTimestamp) {
  if (!lastSeenTimestamp) return 'First time talking to this contact';
  const diffMs = Date.now() - lastSeenTimestamp;
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 5) return 'Active conversation (just spoke a moment ago)';
  if (diffMins < 60) return `Last spoke ${diffMins} minutes ago`;
  const diffHours = Math.floor(diffMs / 3600000);
  if (diffHours < 24) return `Last spoke ${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffDays === 1) return 'Last spoke yesterday';
  return `Last spoke ${diffDays} days ago`;
}

/**
 * Builds the complete multi-layer prompt for the AI model:
 * Layer 1: Core Brain (Immutable backend rules & conversation intelligence)
 * Layer 2: Dynamic Identity, Personality & Voice Tuning
 * Layer 3: Contact Context & Conversation History
 */
export function buildPrompt({
  personalPrompt = '',
  profile = {},
  identity = {},
  personality = {},
  contactFacts = [],
  chatSummary = '',
  senderJid = '',
  contactName = '',
  contactProfile = null,
  contactSettings = null,
  lastSpokeText = '',
  ownerLearnedStyle = null,
  learnedExamples = [],
  ownerKnowledge = ''
}) {
  const timeNow = getFreetownTime();

  let factsSection = 'None recorded yet.';
  if (Array.isArray(contactFacts) && contactFacts.length > 0) {
    factsSection = contactFacts.slice(0, 5).map(f => `- ${String(f).slice(0, 80)}`).join('\n');
  }

  const summarySection = chatSummary ? String(chatSummary).slice(0, 300) : 'First conversation or no older summary yet.';

  // Resolve identity dynamically from identity object or fallback to profile
  const assistantName = identity.assistantName || 'JTech Assistant';
  const ownerName = identity.ownerName || profile.ownerName || profile.name || 'JTech';
  const ownerFirstName = identity.ownerFirstName || profile.ownerFirstName || ownerName;
  const ownerPreferredName = identity.ownerPreferredName || ownerFirstName;
  const ownerAbout = String(identity.ownerAbout || profile.ownerAbout || profile.about || profile.facts || 'Tech software solutions in Freetown').slice(0, 200);
  const ownerLanguages = identity.languages || profile.ownerLanguages || profile.languages || 'English, Krio';
  const writingStyle = identity.writingStyle || profile.writingStyle || 'Warm, natural, respectful, and direct. Sounds like a real person texting from their phone.';

  // Personality tuning parameters
  const replyLength = personality.replyLength || 'medium';
  let lengthGuidance = 'Target length: 1 to 3 natural sentences (around 15 to 50 words). Complete thoughts, never truncated.';
  if (replyLength === 'short') {
    lengthGuidance = 'Target length: Short and concise (1 crisp sentence, around 10 to 25 words).';
  } else if (replyLength === 'detailed') {
    lengthGuidance = 'Target length: Detailed (2 to 4 thoughtful sentences, complete and thorough).';
  }

  const playfulness = personality.playfulness || 'medium';
  let playfulGuidance = 'Playfulness: Balanced warmth and friendly engagement.';
  if (playfulness === 'high') {
    playfulGuidance = 'Playfulness: High. Be witty, playful, and match banter enthusiastically when appropriate.';
  } else if (playfulness === 'low') {
    playfulGuidance = 'Playfulness: Low. Keep tone straightforward, polite, and directly to the point.';
  }

  const formality = personality.formality || 'balanced';
  let formalityGuidance = 'Formality: Balanced, polite, and conversational.';
  if (formality === 'casual') {
    formalityGuidance = 'Formality: Casual and relaxed peer tone.';
  } else if (formality === 'formal') {
    formalityGuidance = 'Formality: Formal, elevated respect, polished manners.';
  }

  const emojiLevel = personality.emojiLevel || 'low';
  let emojiGuidance = 'Emoji usage: Low (at most 1 emoji per message when natural).';
  if (emojiLevel === 'none') {
    emojiGuidance = 'Emoji usage: None. Do not include emojis in text.';
  } else if (emojiLevel === 'moderate') {
    emojiGuidance = 'Emoji usage: Moderate (1 emoji per message where natural).';
  } else if (emojiLevel === 'high') {
    emojiGuidance = 'Emoji usage: High (expressive and lively emoji use).';
  }

  const contactLang = contactProfile?.preferredLanguage || 'English';
  const contactMsgLen = contactProfile?.typicalMessageLength || 'medium';

  const customInstructions = (personalPrompt || '').trim().slice(0, 400);

  // Contact-specific settings
  const targetDisplayName = contactSettings?.displayName || contactProfile?.displayName || contactName || 'Contact';
  const targetRelationship = contactSettings?.relationship || 'Friend / Contact';
  const contactCustomPrompt = (contactSettings?.prompt || '').trim().slice(0, 300);

  // Seniority / Elder detection in relationship
  const relLower = targetRelationship.toLowerCase();
  const isElder = /elder|parent|father|mother|uncle|aunt|senior|boss|director|pastor|imam|chief|dr\b|prof\b/i.test(relLower);

  // Learned style section (behavioral description, not raw text to copy)
  let styleSection = '';
  if (ownerLearnedStyle) {
    const parts = [];
    if (ownerLearnedStyle.globalStyle) {
      parts.push(`Owner's general texting habit: ${String(ownerLearnedStyle.globalStyle).slice(0, 220)}`);
    }
    if (ownerLearnedStyle.contactStyle) {
      parts.push(`How owner texts this specific person: ${String(ownerLearnedStyle.contactStyle).slice(0, 180)}`);
    }
    if (parts.length > 0) {
      styleSection = `\n=== LEARNED TEXTING HABITS (GUIDE ONLY - DO NOT COPY WORDS) ===\n${parts.join('\n')}\n`;
    }
  }

  return `
${CORE_BRAIN}

=== IDENTITY & WORKING RELATIONSHIP ===
- Your Assistant Persona: ${assistantName}
- The Owner: ${ownerName} (also known as ${ownerFirstName}${ownerPreferredName && ownerPreferredName !== ownerFirstName ? ` / "${ownerPreferredName}"` : ''})
- About Owner: ${ownerAbout}
- Time Zone: Africa/Freetown
- Languages: ${ownerLanguages}
- Baseline Style: ${writingStyle}

=== VOICE & PERSONALITY TUNING ===
- ${lengthGuidance}
- ${playfulGuidance}
- ${formalityGuidance}
- ${emojiGuidance}
${customInstructions ? `\nOwner's Custom Instructions:\n${customInstructions}` : ''}
${styleSection}
${ownerKnowledge ? `\n=== OWNER KNOWLEDGE BASE ===\n${ownerKnowledge}\n` : ''}
=== RECIPIENT CONTEXT ===
- Contact Name: ${targetDisplayName}
- Relationship to Owner: ${targetRelationship}${isElder ? ' [NOTE: ELDER / SENIOR - Use extra polite respect and deference]' : ''}
${contactCustomPrompt ? `- Custom Notes For This Person: ${contactCustomPrompt}` : ''}
- Contact Language: ${contactLang}
- Contact Typing Habit: ${contactMsgLen} messages
- Recent Activity: ${lastSpokeText || 'First conversation'}
- Known Facts:
${factsSection}

=== LIVE ENVIRONMENT ===
- Freetown Live Clock: ${timeNow}
- Rolling Chat Context:
${summarySection}
`.trim();
}
