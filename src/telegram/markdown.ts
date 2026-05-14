import { convert } from 'telegram-markdown-v2';

// Telegram limits
const MAX_MESSAGE_LENGTH = 4096;

// Telegram MarkdownV2 has no headings — they collapse to plain bold, which is
// indistinguishable from inline **bold**. We add a per-level emoji prefix so
// section breaks stand out, and ensure a blank line above and below.
const HEADING_PREFIX: Record<number, string> = {
  1: '📌',
  2: '▸',
  3: '·',
  4: '·',
  5: '·',
  6: '·',
};

export function convertToTelegramMarkdown(text: string): string {
  try {
    const preprocessed = preprocessOutsideCode(text);
    return convert(preprocessed, 'escape');
  } catch (error) {
    console.error('Markdown conversion error:', error);
    return escapeMarkdownV2(text);
  }
}

/**
 * Run all non-code preprocessing passes on the source markdown.
 * Splits on ``` fences and only transforms segments outside them.
 */
function preprocessOutsideCode(text: string): string {
  const parts = text.split(/(```[\s\S]*?```)/g);
  return parts.map((segment, i) => {
    // Odd indices are the fenced code blocks captured by the regex
    if (i % 2 === 1) return segment;
    let s = transformHeadings(segment);
    // Thematic breaks (---, ***, ___) — the library leaves *** intact and
    // Telegram then sees it as an unterminated bold/italic entity.
    s = s.replace(/^[ \t]*([\*\-_]){3,}[ \t]*$/gm, '———');
    return s;
  }).join('');
}

/**
 * Convert ATX headings (#, ##, ###, …) to bold lines with a level-specific
 * prefix, and enforce a blank line on either side so they read as section
 * breaks rather than inline bold.
 */
function transformHeadings(text: string): string {
  const inputLines = text.split('\n');
  const output: string[] = [];
  for (let i = 0; i < inputLines.length; i++) {
    const line = inputLines[i];
    const m = line.match(/^(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/);
    if (!m) {
      output.push(line);
      continue;
    }
    const level = m[1].length;
    const title = m[2].trim();
    const prefix = HEADING_PREFIX[level] ?? '·';
    if (output.length > 0 && output[output.length - 1].trim() !== '') {
      output.push('');
    }
    output.push(`**${prefix} ${title}**`);
    if (i + 1 < inputLines.length && inputLines[i + 1].trim() !== '') {
      output.push('');
    }
  }
  return output.join('\n');
}

/**
 * Escape special characters for MarkdownV2 (fallback)
 */
export function escapeMarkdownV2(text: string): string {
  // IMPORTANT: Backslash MUST be first to avoid double-escaping
  // Otherwise: `-` becomes `\-`, then `\` gets escaped to `\\-`
  const specialChars = ['\\', '_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!'];
  let result = text;
  for (const char of specialChars) {
    result = result.replace(new RegExp(`\\${char}`, 'g'), `\\${char}`);
  }
  return result;
}

/**
 * Smart message splitter that respects code blocks and markdown formatting
 */
export function splitMessage(text: string, maxLength: number = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const parts: string[] = [];
  let remaining = text;
  let inCodeBlock = false;
  let codeBlockLang = '';

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      // If we're in a code block, close it properly
      if (inCodeBlock) {
        remaining = remaining + '\n```';
      }
      parts.push(remaining);
      break;
    }

    // Find the chunk to split
    let chunk = remaining.substring(0, maxLength);
    let splitIndex = maxLength;

    // Track code block state in this chunk
    const codeBlockMatches = chunk.matchAll(/```(\w*)?/g);
    let lastCodeBlockIndex: number = -1;
    let tempInCodeBlock: boolean = inCodeBlock;
    let tempLang: string = codeBlockLang;

    for (const match of codeBlockMatches) {
      lastCodeBlockIndex = match.index!;
      if (tempInCodeBlock) {
        // Closing a code block
        tempInCodeBlock = false;
        tempLang = '';
      } else {
        // Opening a code block
        tempInCodeBlock = true;
        tempLang = match[1] || '';
      }
    }

    // If we're ending mid-code-block, we need to handle it carefully
    if (tempInCodeBlock) {
      // Try to find a good split point before the last code block start
      // or at a newline within the code block

      // First, try to split at a newline
      let newlineSplit = chunk.lastIndexOf('\n');

      // If the newline is too early (less than half), look for the last complete line
      if (newlineSplit > maxLength / 2) {
        splitIndex = newlineSplit + 1;
        chunk = remaining.substring(0, splitIndex);

        // Recount code blocks in the adjusted chunk
        const adjustedMatches = chunk.matchAll(/```(\w*)?/g);
        tempInCodeBlock = inCodeBlock;
        tempLang = codeBlockLang;

        for (const match of adjustedMatches) {
          if (tempInCodeBlock) {
            tempInCodeBlock = false;
            tempLang = '';
          } else {
            tempInCodeBlock = true;
            tempLang = match[1] || '';
          }
        }
      }
    } else {
      // Not in a code block - try to split at natural boundaries
      // Priority: paragraph break > newline > space

      const paragraphBreak = chunk.lastIndexOf('\n\n');
      if (paragraphBreak > maxLength / 2) {
        splitIndex = paragraphBreak + 2;
      } else {
        const newlineBreak = chunk.lastIndexOf('\n');
        if (newlineBreak > maxLength / 2) {
          splitIndex = newlineBreak + 1;
        } else {
          const spaceBreak = chunk.lastIndexOf(' ');
          if (spaceBreak > maxLength / 2) {
            splitIndex = spaceBreak + 1;
          }
        }
      }

      chunk = remaining.substring(0, splitIndex);

      // Recount code blocks
      const adjustedMatches = chunk.matchAll(/```(\w*)?/g);
      tempInCodeBlock = inCodeBlock;
      tempLang = codeBlockLang;

      for (const match of adjustedMatches) {
        if (tempInCodeBlock) {
          tempInCodeBlock = false;
          tempLang = '';
        } else {
          tempInCodeBlock = true;
          tempLang = match[1] || '';
        }
      }
    }

    // If we end in a code block, close it and note to reopen
    if (tempInCodeBlock) {
      chunk = chunk.trimEnd() + '\n```';
      inCodeBlock = true;
      codeBlockLang = tempLang;
    } else {
      inCodeBlock = tempInCodeBlock;
      codeBlockLang = tempLang;
    }

    parts.push(chunk);

    // Prepare remaining text
    remaining = remaining.substring(splitIndex).trimStart();

    // If we were in a code block, reopen it
    if (inCodeBlock && remaining.length > 0) {
      remaining = '```' + codeBlockLang + '\n' + remaining;
    }
  }

  // Add part indicators if multiple parts
  if (parts.length > 1) {
    return parts.map((part, index) => {
      const indicator = `\n\n_\\[${index + 1}/${parts.length}\\]_`;
      // Make sure indicator fits
      if (part.length + indicator.length <= maxLength) {
        return part + indicator;
      }
      return part;
    });
  }

  return parts;
}

/**
 * Process and split a message for Telegram
 * Converts markdown and splits into chunks
 */
export function processMessageForTelegram(text: string, maxLength: number = MAX_MESSAGE_LENGTH): string[] {
  // First convert to Telegram markdown format
  const converted = convertToTelegramMarkdown(text);

  // Then split if needed
  return splitMessage(converted, maxLength);
}

// Legacy exports for backwards compatibility
export function escapeMarkdown(text: string): string {
  return escapeMarkdownV2(text);
}

export function formatCodeBlock(code: string, language?: string): string {
  const escaped = code.replace(/`/g, '\\`');
  if (language) {
    return `\`\`\`${language}\n${escaped}\n\`\`\``;
  }
  return `\`\`\`\n${escaped}\n\`\`\``;
}
