import { t } from "./i18n.js";

// Same session raw route MdImg uses; withToken also applies remote-host scoping.
export function rawFileUrl(env, sessionId, path) {
  return env.withToken(`/api/sessions/${encodeURIComponent(sessionId)}/raw?path=${encodeURIComponent(path)}`);
}

const NATIVE_LIMIT = 40 * 1024 * 1024;

export async function downloadFile({ url, name, signal }) {
  const head = await fetch(url, { method: "HEAD", signal });
  if (!head.ok) throw Object.assign(new Error(head.status === 404 ? t("文件不存在或已被移动") : head.status === 403 ? t("没有读取此文件的权限") : `${head.status}`), { status: head.status });
  if (window.DevinNative?.saveBlob) {
    if (Number(head.headers.get("content-length")) > NATIVE_LIMIT) throw new Error(t("文件过大，App 内最多下载 40 MiB，请在浏览器中下载"));
    const response = await fetch(url, { signal });
    if (!response.ok) throw Object.assign(new Error(`${response.status}`), { status: response.status });
    // The APK DownloadListener only accepts blob: URLs; stream through memory.
    const objectUrl = URL.createObjectURL(await response.blob());
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 5000);
  } else {
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
  }
}
