/**
 * Converts the model's markdown output into Telegram-flavoured HTML.
 *
 * Telegram renders <pre><code class="language-x">…</code></pre> with real
 * client-side syntax highlighting (Bot API "pre" entity with a language),
 * so fenced code blocks keep their colours in the chat.
 */

const LANG_ALIASES: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  rb: "ruby",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  yml: "yaml",
  "c++": "cpp",
  "c#": "csharp",
  cs: "csharp",
  golang: "go",
  asm: "x86asm",
  nasm: "x86asm",
  disasm: "x86asm",
  hex: "plaintext",
  hexdump: "plaintext",
  text: "plaintext",
  txt: "plaintext",
};

export function escapeHtml(input: string): string {
  return input.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function normalizeLang(raw: string): string | null {
  const key = raw.trim().toLowerCase().split(/[\s:]/)[0];
  if (!key) return null;
  if (!/^[a-z0-9+#._-]+$/.test(key)) return null;
  return LANG_ALIASES[key] ?? key;
}

/** Inline formatting for non-code segments. */
function inlineToHtml(input: string): string {
  let out = escapeHtml(input);

  // `code`
  out = out.replace(/`([^`\n]+)`/g, (_m, code: string) => `<code>${code}</code>`);
  // [text](url)
  out = out.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_m, label: string, url: string) => `<a href="${url}">${label}</a>`,
  );
  // **bold** and __bold__
  out = out.replace(/\*\*([^\n*]+)\*\*/g, "<b>$1</b>");
  out = out.replace(/__([^\n_]+)__/g, "<b>$1</b>");
  // *italic* / _italic_
  out = out.replace(/(^|[\s(])\*([^\n*]+)\*(?=[\s.,;:!?)]|$)/g, "$1<i>$2</i>");
  out = out.replace(/(^|[\s(])_([^\n_]+)_(?=[\s.,;:!?)]|$)/g, "$1<i>$2</i>");
  // ~~strike~~
  out = out.replace(/~~([^\n~]+)~~/g, "<s>$1</s>");
  // ### headings -> bold line
  out = out.replace(/^\s{0,3}#{1,6}\s+(.+)$/gm, "<b>$1</b>");
  // bullets
  out = out.replace(/^\s{0,3}[-*+]\s+/gm, "• ");

  return out;
}

export type Segment = { type: "text" | "code"; content: string; lang?: string | null };

export function parseSegments(markdown: string): Segment[] {
  const segments: Segment[] = [];
  const fence = /```([^\n`]*)\n?([\s\S]*?)(?:```|$)/g;
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = fence.exec(markdown)) !== null) {
    if (match.index > last) {
      segments.push({ type: "text", content: markdown.slice(last, match.index) });
    }
    segments.push({
      type: "code",
      lang: normalizeLang(match[1] ?? ""),
      content: (match[2] ?? "").replace(/\n+$/, ""),
    });
    last = fence.lastIndex;
  }
  if (last < markdown.length) {
    segments.push({ type: "text", content: markdown.slice(last) });
  }
  return segments;
}

function codeBlockHtml(code: string, lang: string | null | undefined): string {
  const body = escapeHtml(code);
  return lang
    ? `<pre><code class="language-${lang}">${body}</code></pre>`
    : `<pre>${body}</pre>`;
}

/** Full markdown -> Telegram HTML (single string, may exceed message limits). */
export function markdownToTelegramHtml(markdown: string): string {
  return parseSegments(markdown)
    .map((segment) =>
      segment.type === "code"
        ? codeBlockHtml(segment.content, segment.lang)
        : inlineToHtml(segment.content),
    )
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitPlain(text: string, max: number): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
    if (cut < max / 2) cut = max;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.trim()) parts.push(rest);
  return parts;
}

/**
 * Splits markdown into HTML chunks that never break a code block in half:
 * long code blocks are re-fenced per chunk so highlighting survives.
 */
export function markdownToTelegramHtmlChunks(markdown: string, max = 3500): string[] {
  const pieces: string[] = [];

  for (const segment of parseSegments(markdown)) {
    if (segment.type === "code") {
      for (const part of splitPlain(segment.content, max - 120)) {
        pieces.push(codeBlockHtml(part, segment.lang));
      }
    } else {
      const html = inlineToHtml(segment.content);
      if (!html.trim()) continue;
      // Split on blank lines so we never cut inside a tag.
      if (html.length <= max) {
        pieces.push(html);
      } else {
        let buffer = "";
        for (const para of html.split(/\n{2,}/)) {
          const candidate = buffer ? `${buffer}\n\n${para}` : para;
          if (candidate.length > max) {
            if (buffer) pieces.push(buffer);
            buffer = para.length > max ? "" : para;
            if (para.length > max) {
              for (const line of splitPlain(para, max)) pieces.push(line);
            }
          } else {
            buffer = candidate;
          }
        }
        if (buffer.trim()) pieces.push(buffer);
      }
    }
  }

  // Merge small adjacent pieces to reduce message spam.
  const chunks: string[] = [];
  for (const piece of pieces) {
    const current = chunks[chunks.length - 1];
    if (current && current.length + piece.length + 1 <= max) {
      chunks[chunks.length - 1] = `${current}\n${piece}`;
    } else {
      chunks.push(piece);
    }
  }
  return chunks.length ? chunks : [escapeHtml(markdown).slice(0, max)];
}

/** Plain-text fallback used if Telegram rejects the HTML payload. */
export function markdownToPlainText(markdown: string): string {
  return parseSegments(markdown)
    .map((s) => s.content)
    .join("\n")
    .replace(/[*_~`]/g, "")
    .trim();
}
