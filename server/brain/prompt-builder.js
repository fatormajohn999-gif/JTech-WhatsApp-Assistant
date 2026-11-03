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
  lastSpokeText = '',
  isFirstMessage = false
}) {
  const timeNow = getFreetownTime();

  let factsSection = 'None recorded yet.';
  if (Array.isArray(contactFacts) && contactFacts.length > 0) {
    factsSection = contactFacts.map(f => `- ${f}`).join('\n');
  }

  const summarySection = chatSummary ? chatSummary : 'First conversation or no older summary yet.';

  const ownerName = profile.ownerName || profile.name || 'JTech';
  const ownerAbout = profile.ownerAbout || profile.about || profile.facts || 'Leading tech brand and software solutions in Freetown, Sierra Leone';
  const ownerLanguages = profile.ownerLanguages || profile.languages || 'English, Krio';
  const writingStyle = profile.writingStyle || 'Short, warm, natural, respectful, and direct. Sounds like a real person texting.';

  const contactLang = contactProfile?.preferredLanguage || 'English';
  const contactMsgLen = contactProfile?.typicalMessageLength || 'short';

  const customInstructions = (personalPrompt || '').trim();

  return `
${CORE_BRAIN}

=== OWNER INSTRUCTIONS & PERSONALITY ===
- Owner Name: ${ownerName} ${profile.ownerFirstName ? `(First name: ${profile.ownerFirstName})` : ''}
- About Owner & Brand: ${ownerAbout}
- Location: ${profile.city || 'Freetown, Sierra Leone'} (Time zone: ${profile.timeZone || 'Africa/Freetown'})
- Languages Spoken: ${ownerLanguages}
- Writing Style Guidelines: ${writingStyle}
${customInstructions ? `\n- Additional Owner Instructions:\n${customInstructions}` : ''}

=== SAMPLE MESSAGES (TONE BENCHMARKS) ===
Sample 1: "${profile.sampleMessage1 || 'Hello! Thanks for reaching out. How can I help you today?'}"
Sample 2: "${profile.sampleMessage2 || 'Got it, I will check on this and get back to you shortly.'}"
Sample 3: "${profile.sampleMessage3 || 'Have a great day! Let me know if you need anything else.'}"

=== LIVE CONTEXT & CONTACT PROFILE ===
- Current Freetown Date & Time: ${timeNow}
- Contact JID: ${senderJid}
- Contact Display Name: ${contactName || 'Contact'}
- Conversation Activity: ${lastSpokeText || 'First conversation'}
- First Message Flag: ${isFirstMessage ? 'YES - First ever message from this contact (introduce as JTech Assistant).' : 'NO - Ongoing/returning contact (do NOT reintroduce yourself).'}
- Contact Detected Language: ${contactLang}
- Contact Message Length Habit: ${contactMsgLen}

Known Contact Facts:
${factsSection}

Rolling Conversation Summary:
${summarySection}
`.trim();
}
