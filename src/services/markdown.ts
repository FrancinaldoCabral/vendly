/**
 * markdown.ts — Convert standard Markdown (what the LLM emits) into WhatsApp formatting.
 *
 * WhatsApp does NOT render Markdown. Its syntax is different:
 *   bold *texto*   italic _texto_   strike ~texto~   mono ```texto```
 * and it has no headings and no [texto](url) links (raw URLs auto-link on their own).
 *
 * Without this, the customer sees broken markup like **negrito**, ## Título and [texto](url).
 */

/** Markdown → WhatsApp formatting. */
export function toWhatsApp(input: string): string {
  if (!input) return input;
  let s = input.replace(/\r\n/g, '\n');

  // Images ![alt](url) → url (fallback to alt)
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_m, alt, url) => url || alt);

  // Links [texto](url) → "texto (url)"; if no text or text === url → just the url
  s = s.replace(/\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_m, text, url) =>
    (!text || text === url) ? url : `${text} (${url})`);

  // Strikethrough ~~x~~ → ~x~
  s = s.replace(/~~([^\n~]+)~~/g, '~$1~');

  // Italic: a SINGLE asterisk pair (not part of **bold** and not a "* " bullet) → _x_
  // Done before bold so the two never clash. `(?<!\*)` + `(?!\*)` exclude **; `(?!\s)` excludes bullets.
  s = s.replace(/(?<!\*)\*(?!\s)([^*\n]+?)\*(?!\*)/g, '_$1_');

  // Bold **x** / __x__ → *x* (WhatsApp bold)
  s = s.replace(/\*\*([^\n*]+)\*\*/g, '*$1*');
  s = s.replace(/__([^\n_]+)__/g, '*$1*');

  // Line-level: horizontal rules, headings, blockquotes, bullets
  s = s.split('\n').map(line => {
    // Horizontal rule (---, ***, ___) alone on a line → drop
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) return '';
    // Heading (#, ##, …) → bold line
    const h = line.match(/^\s{0,3}#{1,6}\s+(.*)$/);
    if (h) {
      const title = h[1].replace(/\s*#*\s*$/, '').trim();
      return title ? `*${title}*` : '';
    }
    // Blockquote "> x" → "x"
    let l = line.replace(/^\s{0,3}>\s?/, '');
    // Bullet "* " or "+ " → "- " (preserve indentation)
    l = l.replace(/^(\s*)[*+]\s+/, '$1- ');
    return l;
  }).join('\n');

  // Inline code `x` → x (WhatsApp single backticks don't render; keep the text)
  s = s.replace(/`([^`\n]+)`/g, '$1');

  return s.replace(/\n{3,}/g, '\n\n').trim();
}

/** Plain text with no formatting marks — for text-to-speech (so symbols aren't read aloud). */
export function stripFormatting(input: string): string {
  return toWhatsApp(input)
    .replace(/[*_~`]/g, '')
    .replace(/^\s*-\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
