// Copy buttons: an icon that turns into a check once the text is on the clipboard, or into an alert
// when the browser refuses (then the text can still be selected by hand). `text` is read at tap time, so a button
// on a streaming item copies what it shows by then. Each result is also read out through the page's #live region,
// a role="status" region, since the icon change alone says nothing to a screen reader.

const SVG = 'http://www.w3.org/2000/svg';
/** Lucide 1.49.0 paths (licence in index.html). */
const ICONS = {
  copy: ['<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>', '<path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>'],
  check: ['<path d="M20 6 9 17l-5-5"/>'],
  alert: ['<circle cx="12" cy="12" r="10"/>', '<path d="M12 8v4"/>', '<path d="M12 16h.01"/>'],
} as const;
/** How long the check (or the alert) shows before the button is a copy button again. */
const FEEDBACK_MS = 1_600;

/** Says `text` in the #live region: cleared first, then set a frame later, so a repeat is announced again. */
export function announce(text: string): void {
  const live = document.getElementById('live');
  if (!live) return;
  live.textContent = '';
  requestAnimationFrame(() => { live.textContent = text; });
}

function icon(name: keyof typeof ICONS): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[name].join('');
  return svg;
}

/** A button that copies `text()`; `label` names what, as in "Copy message". */
export function copyButton(className: string, label: string, text: () => string): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = `copy ${className}`;
  button.type = 'button';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const show = (state: 'copy' | 'check' | 'alert', swap = true): void => {
    const name = state === 'check' ? `${label} copied` : state === 'alert' ? 'Copy unavailable; select the text instead' : `Copy ${label.toLowerCase()}`;
    button.setAttribute('aria-label', name);
    button.title = name;
    button.dataset.state = state;
    const svg = icon(state);
    // A changed icon pops in (styles.css .icon-pop), so the swap reads as the same button answering.
    if (swap) svg.classList.add('icon-pop');
    button.replaceChildren(svg);
  };
  show('copy', false);
  button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    clearTimeout(timer);
    const done = (state: 'check' | 'alert'): void => {
      show(state);
      announce(state === 'check' ? `${label} copied` : 'Copy unavailable');
      timer = setTimeout(() => show('copy'), FEEDBACK_MS);
    };
    // navigator.clipboard is there only in a secure context (https, as tailscale serve gives).
    if (!('clipboard' in navigator)) { done('alert'); return; }
    navigator.clipboard.writeText(text()).then(() => done('check'), () => done('alert'));
  });
  return button;
}

/** Gives every code block in rendered Markdown a copy button, in a wrapper so it stays put while the code scrolls;
 * the block itself is focusable, so a keyboard can scroll it. */
export function addCodeCopies(root: HTMLElement): void {
  for (const pre of root.querySelectorAll('pre')) {
    const wrap = document.createElement('div');
    wrap.className = 'code-block';
    pre.replaceWith(wrap);
    pre.tabIndex = 0;
    pre.setAttribute('aria-label', 'Code');
    wrap.append(pre, copyButton('copy-code', 'Code', () => pre.textContent ?? ''));
  }
}
