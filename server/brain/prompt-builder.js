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
 * Layer 1: Core Brain (Immutable backend rules)
 * Layer 2: Personal Prompt (Owner customizable instructions & style)
 * Layer 3: Context Layer (Live Freetown clock, contact facts, rolling summary)
 */
export function buildPrompt({
  personalPrompt = '',
  profile = {},
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
    factsSection = contactFacts.map(f => `- ${f}`).join('\n');
  }

  const summarySection = chatSummary ? chatSummary : 'First conversation or no older summary yet.';

  const ownerName = profile.ownerName || profile.name || 'JTech';
  const ownerFirstName = profile.ownerFirstName || ownerName;
  const ownerAbout = profile.ownerAbout || profile.about || profile.facts || 'Tech brand and software solutions';
  const ownerLanguages = profile.ownerLanguages || profile.languages || 'English, Krio';
  const writingStyle = profile.writingStyle || 'Casual, natural, short, respectful, and direct. Sounds like a real person texting from their phone.';

  const contactLang = contactProfile?.preferredLanguage || 'English';
  const contactMsgLen = contactProfile?.typicalMessageLength || 'short';

  const customInstructions = (personalPrompt || '').trim();

  // Contact-specific settings
  const targetDisplayName = contactSettings?.displayName || contactProfile?.displayName || contactName || 'Contact';
  const targetRelationship = contactSettings?.relationship || 'Not specified';
  const contactCustomPrompt = (contactSettings?.prompt || '').trim();

  // Learned style section
  let styleSection = '';
  if (ownerLearnedStyle) {
    const parts = [];
    if (ownerLearnedStyle.globalStyle) {
      parts.push(`General texting voice:\n${ownerLearnedStyle.globalStyle}`);
    }
    if (ownerLearnedStyle.contactStyle) {
      parts.push(`How the owner texts this specific person:\n${ownerLearnedStyle.contactStyle}`);
    }
    if (parts.length > 0) {
      styleSection = `\n=== HOW THE OWNER TEXTS (LEARNED STYLE) ===\n${parts.join('\n\n')}\n`;
    }
  }

  // Learned examples section (3 to 5 real reply pairs)
  let examplesSection = '';
  if (Array.isArray(learnedExamples) && learnedExamples.length > 0) {
    const formattedPairs = learnedExamples.slice(0, 5).map((ex, i) => 
      `Example ${i + 1}:\nContact: "${ex.contactMessage || '(incoming message)'}"\nOwner: "${ex.ownerReply}"`
    ).join('\n\n');
    examplesSection = `\n=== EXAMPLES OF HOW THE OWNER ACTUALLY ANSWERED ===\n(Follow the spirit, tone, and brevity of these answers; do not copy them word-for-word unless identical situation)\n${formattedPairs}\n`;
  }

  return `
${CORE_BRAIN}

=== INSTRUCTIONS FOR THIS SPECIFIC PERSON ===
- Name / Nickname: ${targetDisplayName}
- Relationship: ${targetRelationship}
${contactCustomPrompt ? `- Custom instructions for this contact:\n${contactCustomPrompt}` : '- Custom instructions: Treat with standard respect and warmth according to the relationship.'}
(Note: These specific person instructions customize your voice and topics for this chat, but core safety, honesty, and [FOR_OWNER] escalation remain strictly enforced.)

=== OWNER PROFILE (WHO YOU WORK FOR) ===
- Owner Name: ${ownerName}
- Owner First Name (refer to them naturally as this): ${ownerFirstName}
- About Owner: ${ownerAbout}
- Time Zone: ${profile.timeZone || 'Africa/Freetown'}
- Languages: ${ownerLanguages}
- Preferred Writing Style: ${writingStyle}
${customInstructions ? `\n- General Texting Instructions:\n${customInstructions}` : ''}
${styleSection}
${examplesSection}
${ownerKnowledge ? `\n${ownerKnowledge}\n` : ''}
=== LIVE TIME & CONTEXT ===
- Live Time Awareness (Freetown): ${timeNow}
- Contact JID: ${senderJid}
- Contact Preferred Language: ${contactLang}
- Contact Texting Habit: ${contactMsgLen} messages
- Recent Activity: ${lastSpokeText || 'First conversation'}

Known Permanent Facts About This Contact:
${factsSection}

Rolling Conversation Context:
${summarySection}
`.trim();
}

