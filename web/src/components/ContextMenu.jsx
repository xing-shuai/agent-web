import React from "react";

/** menu: {x, y, items: [{label, icon?, onClick, danger?} | {sep:true}]} */
export default function ContextMenu({ menu, onClose }) {
  if (!menu) return null;
  const w = 200;
  const h = menu.items.reduce((n, i) => n + (i.sep ? 10 : 38), 12);
  const x = Math.min(menu.x, window.innerWidth - w - 8);
  const y = Math.min(menu.y, window.innerHeight - h - 8);
  return (
    <div
      className="ctx-backdrop"
      onMouseDown={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div
        className="ctx-menu"
        style={{ left: x, top: y, minWidth: w }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {menu.items.map((it, i) =>
          it.sep ? (
            <div key={i} className="ctx-sep" />
          ) : (
            <button
              key={i}
              className={"ctx-item" + (it.danger ? " danger" : "")}
              onClick={() => {
                onClose();
                it.onClick();
              }}
            >
              {it.icon && <it.icon size={15} />}
              {it.label}
            </button>
          )
        )}
      </div>
    </div>
  );
}
