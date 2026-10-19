// The TUI's one palette. Colors are terminal palette indices (0-15), so they follow the user's
// light or dark scheme; there are no hard backgrounds. Accents: cyan (Pi, tools), magenta (agents).
import { indexedColor, styleText } from '@earendil-works/pi-tui';
import type { EditorTheme, MarkdownTheme, SelectListTheme, TextStyle } from '@earendil-works/pi-tui';

export type Style = (text: string) => string;

/** Styles shared by the chat, the footer, the editor and the panels. */
export interface Theme {
  readonly accent: Style;
  /** Agents: reports and names. */
  readonly agent: Style;
  readonly success: Style;
  readonly warning: Style;
  readonly error: Style;
  readonly dim: Style;
  readonly bold: Style;
  readonly italic: Style;
  /** Borders and rules. */
  readonly border: Style;
  /** The selected row of a list (also what the panels' PanelTheme needs). */
  readonly selected: Style;
  readonly markdown: MarkdownTheme;
  readonly editor: EditorTheme;
  readonly selectList: SelectListTheme;
}

const style = (options: TextStyle): Style => text => styleText(text, options, '256color');
const red = indexedColor(1), green = indexedColor(2), yellow = indexedColor(3);
const magenta = indexedColor(5), cyan = indexedColor(6);

const accent = style({ fg: cyan });
const dim = style({ dim: true });
const bold = style({ bold: true });
const italic = style({ italic: true });

const selected = style({ fg: cyan, bold: true });
const selectList: SelectListTheme = {
  selectedPrefix: accent,
  selectedText: selected,
  description: dim,
  scrollInfo: dim,
  noMatch: dim,
};

export const theme: Theme = {
  accent,
  agent: style({ fg: magenta }),
  success: style({ fg: green }),
  warning: style({ fg: yellow }),
  error: style({ fg: red }),
  dim,
  bold,
  italic,
  border: dim,
  selected,
  markdown: {
    heading: style({ fg: cyan, bold: true }),
    link: style({ fg: cyan, underline: true }),
    linkUrl: dim,
    code: accent,
    codeBlock: text => text,
    codeBlockBorder: dim,
    quote: italic,
    quoteBorder: dim,
    hr: dim,
    listBullet: accent,
    bold,
    italic,
    strikethrough: style({ strikethrough: true }),
    underline: style({ underline: true }),
  },
  editor: { borderColor: dim, selectList },
  selectList,
};
