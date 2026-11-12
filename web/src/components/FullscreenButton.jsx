import React from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import { useFullscreen } from "../useFullscreen.js";
import { t } from "../i18n.js";

export default function FullscreenButton({ className = "icon-ghost", size = 15 }) {
  const { supported, active, toggle } = useFullscreen();
  if (!supported) return null;
  const Icon = active ? Minimize2 : Maximize2;
  return (
    <button className={className} title={active ? t("退出全屏") : t("全屏")} onClick={toggle}>
      <Icon size={size} />
    </button>
  );
}
