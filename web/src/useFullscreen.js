import { useCallback, useEffect, useState } from "react";

// Fullscreen toggle support. Hidden entirely when the API is unavailable
// or the app is already running installed (fullscreen/standalone display
// mode), where a fullscreen button would be meaningless.
export function useFullscreen() {
  const [supported] = useState(
    () =>
      !!document.fullscreenEnabled &&
      !window.matchMedia("(display-mode: fullscreen)").matches &&
      !window.matchMedia("(display-mode: standalone)").matches
  );
  const [active, setActive] = useState(!!document.fullscreenElement);

  useEffect(() => {
    const onChange = () => setActive(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggle = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      document.documentElement
        .requestFullscreen({ navigationUI: "hide" })
        .catch(() => {});
    }
  }, []);

  return { supported, active, toggle };
}
