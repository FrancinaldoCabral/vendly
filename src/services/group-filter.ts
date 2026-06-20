/**
 * group-filter.ts — Configurable group message filter
 * Ported from stack-mcp deliverer mention/reply detection, generalized for any agent.
 * Only applies to group JIDs (@g.us). Individual contacts always pass through.
 */

export interface GroupConfig {
  respondToMentions: boolean;  // respond when @agentPhone appears in text
  respondToReplies: boolean;   // respond when message is a reply to bot's own message
  respondToAll?: boolean;      // bypass all filters (useful for support groups)
}

export interface GroupFilterInput {
  jid: string;
  messageText: string;
  /** waExternalId present → this message is a reply to a specific prior message */
  waExternalId?: string | null;
  agentPhone?: string | null;
  /** All known identities of the bot (phone + any @lid). Preferred over agentPhone. */
  agentPhones?: string[];
  senderPhone?: string | null;
  /** Phone numbers from the message's contextInfo.mentionedJid — the AUTHORITATIVE mention source
   *  (WhatsApp puts @mentions here, not always as @<number> in the visible text). */
  mentionedPhones?: string[];
  /** When we don't yet know the bot's @lid, treat ANY mention as targeting it (bootstrap). The bot's
   *  first reply teaches us its lid and this turns off, so mentions become precise. */
  lenientMention?: boolean;
  groupConfig: GroupConfig;
}

export interface GroupFilterResult {
  pass: boolean;
  reason: string;
}

/**
 * Returns { pass: true } if the message should be processed by the agent.
 * Always passes for non-group JIDs.
 */
export function groupFilter(input: GroupFilterInput): GroupFilterResult {
  const { jid, messageText, waExternalId, groupConfig } = input;
  const agentPhones = (input.agentPhones && input.agentPhones.length)
    ? input.agentPhones
    : (input.agentPhone ? [input.agentPhone] : []);

  // Not a group — always pass
  if (!jid.endsWith('@g.us')) {
    return { pass: true, reason: 'individual contact' };
  }

  // Bypass mode — pass everything in the group
  if (groupConfig.respondToAll) {
    return { pass: true, reason: 'respondToAll enabled' };
  }

  // Reply check: message has a reply context (waExternalId present → reply to the bot's message)
  if (groupConfig.respondToReplies && waExternalId) {
    return { pass: true, reason: `reply detected (waExternalId=${waExternalId})` };
  }

  // Mention check. Prefer the authoritative mentionedJid phones; fall back to @<number> in text.
  if (groupConfig.respondToMentions) {
    const mentions = (input.mentionedPhones && input.mentionedPhones.length)
      ? input.mentionedPhones
      : extractMentions(messageText);

    const mentionedAgent = agentPhones.length > 0 && mentions.some(p =>
      agentPhones.some(b => p === b || b.endsWith(p) || p.endsWith(b))
    );
    if (mentionedAgent) return { pass: true, reason: `agent mentioned` };
    // Bot @lid not resolved yet (or no identities) — any mention passes as a bootstrap.
    if ((input.lenientMention || agentPhones.length === 0) && mentions.length > 0) {
      return { pass: true, reason: `mention detected (bot id not resolved — lenient)` };
    }
  }

  return {
    pass: false,
    reason: `group message filtered (respondToMentions=${groupConfig.respondToMentions} respondToReplies=${groupConfig.respondToReplies} waExternalId=${waExternalId ?? 'none'} mentions=${(input.mentionedPhones?.length ? input.mentionedPhones : extractMentions(messageText)).join(',') || 'none'})`,
  };
}

function extractMentions(text: string): string[] {
  return [...text.matchAll(/@(\d{7,})/g)].map(m => m[1]);
}
