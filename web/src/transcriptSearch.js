import { createContext } from "react";

export const TranscriptSearch = createContext({ query: "", keys: new Set() });

export function itemSearchText(item) {
  if (item.kind === "toolgroup" || item.kind === "processgroup") return item.items.map(itemSearchText).join("\n");
  return [item.text, item.summary, item.error, item.title, item.name, item.toolName, item.entries, item.rawInput, item.rawOutput, item.content, item.locations]
    .filter((value) => value != null)
    .map((value) => typeof value === "string" ? value : JSON.stringify(value)).join("\n");
}

export function transcriptHits(wrappers, query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return wrappers.flatMap(({ it, key }) => {
    if (it.kind === "filesTouched") return [];
    const leaves = it.kind === "toolgroup" || it.kind === "processgroup" ? it.items : [it];
    return leaves.filter((leaf) => itemSearchText(leaf).toLowerCase().includes(q))
      .map((leaf) => ({ key, itemKey: leaf.key }));
  });
}

/** CSS ranges leave React's text/markdown DOM untouched. Older engines get a
 * parent highlight instead; cleanup never replaces text nodes. */
export function highlightMatch(root, query) {
  const q = query.toLowerCase();
  const nodes = [];
  const walker = document.createTreeWalker(root, document.defaultView.NodeFilter.SHOW_TEXT);
  let text = "", node;
  while ((node = walker.nextNode())) {
    if (node.parentElement?.closest('[inert], script, style, details:not([open]) > :not(summary)')) continue;
    nodes.push({ node, start: text.length, end: text.length + node.textContent.length });
    text += node.textContent;
  }
  const ranges = [];
  const lower = text.toLowerCase();
  for (let start = lower.indexOf(q); q && start >= 0 && ranges.length < 200; start = lower.indexOf(q, start + q.length)) {
    const from = nodes.find((n) => n.end > start);
    const to = nodes.find((n) => n.end >= start + q.length);
    if (!from || !to) break;
    const range = document.createRange();
    range.setStart(from.node, start - from.start);
    range.setEnd(to.node, start + q.length - to.start);
    ranges.push(range);
  }
  const registry = globalThis.CSS?.highlights;
  const fallback = ranges[0]?.startContainer.parentElement;
  if (registry && typeof globalThis.Highlight === "function") registry.set("chat-search", new Highlight(...ranges));
  else fallback?.classList.add("search-text-hit");
  return {
    range: ranges[0],
    clear() { registry?.delete("chat-search"); fallback?.classList.remove("search-text-hit"); },
  };
}

export function revealMatch(range, transcript, fallback) {
  if (!range?.getBoundingClientRect) return fallback?.scrollIntoView?.({ block: "center" });
  // Scroll each bounded output pane, then the transcript, to the actual text
  // line rather than the centre of a possibly enormous <pre> or tool group.
  for (let el = range.startContainer.parentElement; el && transcript.contains(el); el = el.parentElement) {
    const overflow = getComputedStyle(el).overflowY;
    if (el !== transcript && !["auto", "scroll"].includes(overflow)) continue;
    const rect = range.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    el.scrollTop += rect.top - box.top - el.clientHeight / 2;
  }
}
