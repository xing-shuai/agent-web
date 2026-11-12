// Splits a growing Markdown stream into committed prefix blocks plus a
// reparsed tail. Splits only ever happen at blank-line boundaries whose
// following line is complete, so each emitted block parses identically to
// its slice of the final document.

import { createContext } from "react";

// True while a code block is the still-growing streaming tail: skip the
// highlight worker (like active search) and render plain text until commit.
export const StreamingTailContext = createContext(false);

const LIST_ITEM = /^ {0,3}([-+*]|\d{1,9}[.)])(\s|$)/;
const BLOCKQUOTE = /^ {0,3}>/;
const INDENTED = /^( {4,}|\t)/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
// Link reference and footnote definitions affect the whole document — a
// document containing one is never block-split.
const REFERENCE = /^ {0,3}\[[^\]\n]+\]:/m;
// Raw HTML is dropped from rendered output; splitting inside a construct
// that survives blank lines would revive its contents as a paragraph.
const HTML_OPENERS = [
  [/^ {0,3}<script(?=[\s>]|$)/i, /<\/script>/i],
  [/^ {0,3}<pre(?=[\s>]|$)/i, /<\/pre>/i],
  [/^ {0,3}<style(?=[\s>]|$)/i, /<\/style>/i],
  [/^ {0,3}<textarea(?=[\s>]|$)/i, /<\/textarea>/i],
  [/^ {0,3}<\?/, /\?>/],
  [/^ {0,3}<!\[CDATA\[/, /\]\]>/],
  [/^ {0,3}<![A-Za-z]/, />/],
];

function scanComment(line, open) {
  let i = 0;
  while (i < line.length) {
    if (open) {
      const end = line.indexOf("-->", i);
      if (end === -1) return true;
      open = false; i = end + 3;
    } else {
      const start = line.indexOf("<!--", i);
      if (start === -1) return false;
      open = true; i = start + 4;
    }
  }
  return open;
}

export function splitStreamingMarkdown(text) {
  if (!text || REFERENCE.test(text)) return [text];
  const blocks = [];
  let blockStart = 0, pos = 0;
  let fence = null, commentOpen = false, htmlEnd = null;
  let blockHasList = false, prevBlockquote = false, blankRun = 0;
  while (pos < text.length) {
    const nl = text.indexOf("\n", pos);
    const end = nl === -1 ? text.length : nl + 1;
    const raw = text.slice(pos, end);
    const content = raw.replace(/\r?\n$/, "");
    if (fence) {
      const close = content.match(fence.ch === "`" ? /^ {0,3}(`{3,})[ \t]*$/ : /^ {0,3}(~{3,})[ \t]*$/);
      if (close && close[1].length >= fence.len) { fence = null; blankRun = 0; prevBlockquote = false; }
      pos = end;
      continue;
    }
    if (content.trim() === "") {
      blankRun++;
      pos = end;
      continue;
    }
    // Candidate boundary: this non-blank line starts a new block when it is
    // complete and nothing keeps it attached to the current block.
    if (blankRun >= 1 && raw.endsWith("\n") && !commentOpen && !htmlEnd &&
        !INDENTED.test(content) &&
        !(LIST_ITEM.test(content) && blockHasList) &&
        !(BLOCKQUOTE.test(content) && prevBlockquote) &&
        !(content.startsWith(" ") && blockHasList)) {
      blocks.push(text.slice(blockStart, pos));
      blockStart = pos;
      blockHasList = false;
      commentOpen = false;
      htmlEnd = null;
    }
    const opener = content.match(FENCE_OPEN);
    if (opener) {
      fence = { ch: opener[1][0], len: opener[1].length };
    } else {
      commentOpen = scanComment(content, commentOpen);
      if (htmlEnd) {
        if (htmlEnd.test(content)) htmlEnd = null;
      } else {
        for (const [open, close] of HTML_OPENERS) {
          if (open.test(content)) {
            const rest = content.slice(content.indexOf("<"));
            if (!close.test(rest)) htmlEnd = close;
            break;
          }
        }
      }
    }
    if (LIST_ITEM.test(content)) blockHasList = true;
    prevBlockquote = BLOCKQUOTE.test(content);
    blankRun = 0;
    pos = end;
  }
  blocks.push(text.slice(blockStart));
  return blocks;
}
