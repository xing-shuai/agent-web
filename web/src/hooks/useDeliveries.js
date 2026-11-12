import { useCallback, useEffect, useRef } from "react";
import { environment } from "../api.js";
import { emptySession } from "../sessionReducer.js";
import { sessionKey } from "../splitLayout.js";
import { t } from "../i18n.js";

export function readDeliveries() {
  const deliveries = new Map();
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (!key?.startsWith("dw.promptDeliveries")) continue;
      const host = key === "dw.promptDeliveries" ? "" : key.slice("dw.promptDeliveries@".length);
      for (const d of JSON.parse(sessionStorage.getItem(key) || "[]").slice(-50)) {
        if (!d.id || !d.sessionId || !Array.isArray(d.blocks)) continue;
        deliveries.set(d.id, { ...d, host: d.host ?? host,
          phase: d.phase === "failed" ? "failed" : "uncertain",
          error: d.phase === "failed" ? d.error : t("页面已重载，正在核对消息是否被接收。") });
      }
    }
  } catch {}
  return deliveries;
}
function saveDeliveries(deliveries) {
  try {
    const byHost = new Map();
    for (const d of deliveries.values()) {
      const list = byHost.get(d.host || "") || [];
      list.push(d);
      byHost.set(d.host || "", list);
    }
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const key = sessionStorage.key(i);
      if (key?.startsWith("dw.promptDeliveries")) sessionStorage.removeItem(key);
    }
    for (const [host, list] of byHost) sessionStorage.setItem(environment(host).storageKey("dw.promptDeliveries"), JSON.stringify(list));
    return true;
  } catch { return false; }
}

// Pending-send receipts: persisted per host in tab storage, resolved by
// prompt_delivery / prompt_result, and marked uncertain after a timeout.
export default function useDeliveries({ setSessionData, notify }) {
  const deliveryRef = useRef(null);
  if (!deliveryRef.current) deliveryRef.current = readDeliveries();
  const updateDelivery = useCallback((host, sessionId, requestId, patch) => {
    const previous = deliveryRef.current.get(requestId);
    if (!previous || previous.sessionId !== sessionId || (previous.host || "") !== host) return;
    const delivery = { ...previous, ...patch };
    const finished = ["completed", "cancelled"].includes(delivery.phase);
    if (finished) deliveryRef.current.delete(requestId);
    else deliveryRef.current.set(requestId, delivery);
    if (!saveDeliveries(deliveryRef.current)) notify?.({ host, kind: "warn", text: t("浏览器暂存空间不足，待确认消息仅保留在本页；请勿刷新。") });
    const key = sessionKey(host, sessionId);
    setSessionData((all) => {
      const session = all[key];
      if (!session) return all;
      return { ...all, [key]: { ...session,
        deliveries: (session.deliveries || []).map((item) => item.id === requestId ? delivery : item).filter((item) => !finished || item.id !== requestId),
        items: ["queued", "cancelled"].includes(delivery.phase) ? session.items.filter((item) => item.deliveryId !== requestId || !item.optimistic) : session.items,
      } };
    });
  }, [setSessionData, notify]);
  useEffect(() => {
    const timer = setInterval(() => {
      for (const delivery of deliveryRef.current.values()) {
        if (["sending", "receiving"].includes(delivery.phase) && Date.now() - delivery.sentAt > 12000)
          updateDelivery(delivery.host || "", delivery.sessionId, delivery.id, { phase: "uncertain", error: t("尚未收到确认，原消息可能已被接收，请勿直接重复发送。") });
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [updateDelivery]);
  return { deliveryRef, updateDelivery, saveDeliveries };
}
