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
  senderPhone?: string | null;
  /** Phone numbers from the message's contextInfo.mentionedJid — the AUTHORITATIVE mention source
   *  (WhatsApp puts @mentions here, not always as @<number> in the visible text). */
  mentionedPhones?: string[];
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
  const { jid, messageText, waExternalId, agentPhone, groupConfig } = input;

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

    if (agentPhone) {
      // We know the bot's number — pass ONLY when the bot itself is mentioned.
      const mentionedAgent = mentions.some(p =>
        p === agentPhone || agentPhone.endsWith(p) || p.endsWith(agentPhone)
      );
      if (mentionedAgent) return { pass: true, reason: `agent mentioned (@${agentPhone})` };
    } else if (mentions.length > 0) {
      // Bot number not resolved — best effort: any mention passes.
      return { pass: true, reason: `mention detected (agentPhone not resolved)` };
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
