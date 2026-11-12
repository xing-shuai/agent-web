import rehypeHighlight from "rehype-highlight";

const transform = rehypeHighlight({ detect: false, ignoreMissing: true });

// Coloring is optional; text is not. Bound both parsing and the number of
// spans React would need to mount for a single visible block.
export function highlightCode(code, language) {
  if (typeof code !== "string" || code.length > 200000 || typeof language !== "string" || !/^[\w#+-]{1,128}$/.test(language)) return null;
  const node = { type: "element", tagName: "code", properties: { className: [`language-${language}`] }, children: [{ type: "text", value: code }] };
  transform({ type: "root", children: [{ type: "element", tagName: "pre", properties: {}, children: [node] }] }, { message() {} });
  const stack = node.children.map((node) => ({ node, depth: 0 }));
  let count = 0, bytes = 0;
  while (stack.length) {
    const { node, depth } = stack.pop();
    if (++count > 4000 || depth > 64) return null;
    bytes += 96 + (node.value?.length || 0) * 2 + (node.properties?.className?.join(" ").length || 0) * 2;
    if (node.children) for (const child of node.children) stack.push({ node: child, depth: depth + 1 });
  }
  return { nodes: node.children, bytes };
}

if (typeof self !== "undefined" && typeof document === "undefined") self.onmessage = ({ data }) => {
  let result = null;
  try { result = highlightCode(data.code, data.language); } catch { /* keep the complete plain text */ }
  self.postMessage({ id: data.id, result });
};
