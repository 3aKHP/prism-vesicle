const SUPERSCRIPT_CHARS: Record<string, string> = {
  "0": "⁰",
  "1": "¹",
  "2": "²",
  "3": "³",
  "4": "⁴",
  "5": "⁵",
  "6": "⁶",
  "7": "⁷",
  "8": "⁸",
  "9": "⁹",
  "+": "⁺",
  "-": "⁻",
  "=": "⁼",
  "(": "⁽",
  ")": "⁾",
  n: "ⁿ",
  i: "ⁱ",
};

const SUBSCRIPT_CHARS: Record<string, string> = {
  "0": "₀",
  "1": "₁",
  "2": "₂",
  "3": "₃",
  "4": "₄",
  "5": "₅",
  "6": "₆",
  "7": "₇",
  "8": "₈",
  "9": "₉",
  "+": "₊",
  "-": "₋",
  "=": "₌",
  "(": "₍",
  ")": "₎",
  a: "ₐ",
  e: "ₑ",
  h: "ₕ",
  i: "ᵢ",
  j: "ⱼ",
  k: "ₖ",
  l: "ₗ",
  m: "ₘ",
  n: "ₙ",
  o: "ₒ",
  p: "ₚ",
  r: "ᵣ",
  s: "ₛ",
  t: "ₜ",
  u: "ᵤ",
  v: "ᵥ",
  x: "ₓ",
};

const EMOJI_SHORTCODES: Record<string, string> = {
  smile: "😄",
  rocket: "🚀",
  warning: "⚠️",
  fire: "🔥",
  crystal_ball: "🔮",
  "+1": "👍",
  "-1": "👎",
  shipit: "🚢",
};

export function renderMarkdownFormattingExtensions(input: string): string {
  return renderEmojiShortcodes(
    renderDefinitionLists(
      renderFootnotes(
        renderNativeScripts(
          renderHtmlMarkdownFallbacks(
            renderImages(
              renderHighlightMarks(input),
            ),
          ),
        ),
      ),
    ),
  );
}

function renderHighlightMarks(input: string): string {
  return input.replace(/(^|[^=])==([^=\n][^=\n]*?)==(?!=)/g, (_match, prefix: string, value: string) => `${prefix}▰ ${value.trim()} ▰`);
}

function renderImages(input: string): string {
  return input.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_match, label: string, url: string) => {
    const alt = label.trim() || "image";
    return `🖼 ${alt} (${url})`;
  });
}

function renderHtmlMarkdownFallbacks(input: string): string {
  return input
    .replace(/<details>\s*<summary>([\s\S]*?)<\/summary>\s*([\s\S]*?)<\/details>/gi, (_match, summary: string, body: string) => {
      const title = stripKnownHtml(summary).trim();
      const content = stripKnownHtml(body).trim();
      return content ? `▸ ${title}\n${content}` : `▸ ${title}`;
    })
    .replace(/<abbr\s+title=(["'])(.*?)\1>([\s\S]*?)<\/abbr>/gi, (_match, _quote: string, title: string, label: string) => {
      return `${stripKnownHtml(label).trim()} (${title.trim()})`;
    })
    .replace(/<kbd>([\s\S]*?)<\/kbd>/gi, (_match, value: string) => `‹${stripKnownHtml(value).trim()}›`)
    .replace(/<mark>([\s\S]*?)<\/mark>/gi, (_match, value: string) => `▰ ${stripKnownHtml(value).trim()} ▰`)
    .replace(/<u>([\s\S]*?)<\/u>/gi, (_match, value: string) => `＿${stripKnownHtml(value).trim()}＿`)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p(?:\s+[^>]*)?>/gi, "\n")
    .replace(/<\/?(?:div|p)(?:\s+[^>]*)?>/gi, "");
}

function stripKnownHtml(input: string): string {
  return input
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p(?:\s+[^>]*)?>/gi, "\n")
    .replace(/<\/?(?:div|p|span|summary|details|mark|u|kbd|abbr)(?:\s+[^>]*)?>/gi, "");
}

function renderNativeScripts(input: string): string {
  return input
    .replace(/(^|[^~])~([A-Za-z0-9+\-=()]{1,8})~(?!~)/g, (match, prefix: string, value: string) => {
      if (!shouldRenderScript(value)) return match;
      return `${prefix}${mapScript(value, SUBSCRIPT_CHARS)}`;
    })
    .replace(/(^|[^^])\^([A-Za-z0-9+\-=()]{1,8})\^(?!\^)/g, (match, prefix: string, value: string) => {
      if (!shouldRenderScript(value)) return match;
      return `${prefix}${mapScript(value, SUPERSCRIPT_CHARS)}`;
    });
}

function shouldRenderScript(value: string): boolean {
  return /\d/.test(value) || value.length === 1;
}

function mapScript(value: string, map: Record<string, string>): string {
  return Array.from(value).map((char) => map[char] ?? char).join("");
}

function renderFootnotes(input: string): string {
  return input
    .replace(/^\[\^([^\]]+)\]:\s*(.+)$/gm, (_match, label: string, body: string) => `［${label}］ ${body}`)
    .replace(/\[\^([^\]]+)\]/g, (_match, label: string) => `［${label}］`);
}

function renderDefinitionLists(input: string): string {
  const output: string[] = [];

  for (const line of input.split(/\r?\n/)) {
    const definition = line.match(/^:\s+(.+)$/);
    if (!definition) {
      output.push(line);
      continue;
    }

    const value = definition[1];
    const previous = output[output.length - 1];
    if (previous && previous.trim().length > 0 && !previous.trimStart().startsWith("→") && !previous.includes(" — ")) {
      output[output.length - 1] = `${previous} — ${value}`;
    } else {
      output.push(`  → ${value}`);
    }
  }

  return output.join("\n");
}

function renderEmojiShortcodes(input: string): string {
  return input.replace(/:([+\-\w]+):/g, (match, name: string) => EMOJI_SHORTCODES[name] ?? match);
}
