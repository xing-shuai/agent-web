import React, { useMemo } from "react";
import { FileDiff } from "lucide-react";

/** Line-level LCS diff. Falls back to block view for very large inputs. */
function lineDiff(oldText, newText) {
  const a = (oldText ?? "").split("\n");
  const b = (newText ?? "").split("\n");
  if (a.length * b.length > 200000) {
    return [
      ...a.map((t) => ({ type: "del", text: t })),
      ...b.map((t) => ({ type: "add", text: t })),
    ];
  }
  const m = a.length,
    n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const rows = [];
  let i = 0,
    j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      rows.push({ type: "same", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ type: "del", text: a[i++] });
    } else {
      rows.push({ type: "add", text: b[j++] });
    }
  }
  while (i < m) rows.push({ type: "del", text: a[i++] });
  while (j < n) rows.push({ type: "add", text: b[j++] });
  return rows;
}

export default function DiffView({ path, oldText, newText }) {
  const rows = useMemo(() => lineDiff(oldText, newText), [oldText, newText]);
  return (
    <div className="diff">
      {path && (
        <div className="diff-path">
          <FileDiff size={13} />
          {path}
        </div>
      )}
      <pre className="diff-body">
        {rows.map((r, i) => (
          <div key={i} className={`dl ${r.type}`}>
            <span className="dl-sign">{r.type === "add" ? "+" : r.type === "del" ? "−" : " "}</span>
            {r.text}
          </div>
        ))}
      </pre>
    </div>
  );
}
