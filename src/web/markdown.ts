// Markdown to sanitized HTML for assistant text. Raw HTML in the source is shown as text, links keep only
// http(s) and mailto targets and open with rel="noopener noreferrer", and images become plain links: nothing a
// model writes can run script, load a resource, or style the page. The result goes to innerHTML.
import { Marked } from 'marked';
import type { Tokens } from 'marked';

const ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, ch => ESCAPES[ch] ?? ch);

/** `href` when it is an absolute http(s) or mailto URL, else undefined. */
export function safeHref(href: string): string | undefined {
  let url: URL;
  try { url = new URL(href.trim()); } catch { return undefined; }
  return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:' ? url.href : undefined;
}

const anchor = (href: string, title: string | null | undefined, inner: string): string =>
  `<a href="${escapeHtml(href)}"${title ? ` title="${escapeHtml(title)}"` : ''} target="_blank" rel="noopener noreferrer">${inner}</a>`;

const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    // Raw HTML, block or inline, is shown as the text it is.
    html({ text }: Tokens.HTML | Tokens.Tag): string { return escapeHtml(text); },
    link({ href, title, tokens }: Tokens.Link): string {
      const inner = this.parser.parseInline(tokens);
      const safe = safeHref(href);
      return safe ? anchor(safe, title, inner) : inner;
    },
    image({ href, title, text }: Tokens.Image): string {
      const label = escapeHtml(text || href);
      const safe = safeHref(href);
      return safe ? anchor(safe, title, `${label} (image)`) : label;
    },
  },
});

/** `source` as sanitized HTML. */
export function renderMarkdown(source: string): string {
  return marked.parse(source, { async: false });
}
