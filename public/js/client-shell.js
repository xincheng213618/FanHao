export function prepareClientShell() {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.getRegistrations?.().then((registrations) => {
        for (const registration of registrations) registration.unregister().catch(() => {});
      }).catch(() => {});
    });
  }
  if ("caches" in window) {
    window.addEventListener("load", () => {
      caches.keys().then((names) => {
        for (const name of names) {
          if (name.startsWith("fanhao-shell-")) caches.delete(name).catch(() => {});
        }
      }).catch(() => {});
    });
  }
}

export function installAndroidClientReturn({ isAndroidClient, initialParams }) {
  if (!isAndroidClient || document.querySelector(".android-client-return")) return;
  const returnTo = safeAndroidReturnUrl(initialParams?.get("returnTo"));
  const button = document.createElement("button");
  button.type = "button";
  button.className = "android-client-return";
  button.textContent = "‹ 返回客户端";
  button.setAttribute("aria-label", "返回客户端首页");

  let returning = false;
  const returnToClient = () => {
    if (returning) return;
    returning = true;
    button.textContent = "正在返回";
    if (returnTo) {
      fallbackReturnToClient(returnTo);
      return;
    }
    if (window.history.length > 1) {
      const currentUrl = window.location.href;
      window.history.back();
      window.setTimeout(() => {
        if (window.location.href === currentUrl && !document.hidden) fallbackReturnToClient("");
      }, 700);
      return;
    }
    fallbackReturnToClient("");
  };

  button.addEventListener("click", returnToClient);
  button.addEventListener("touchend", (event) => {
    event.preventDefault();
    returnToClient();
  }, { passive: false });
  document.body.append(button);
}

export function isTrustedNetworkFeatureAvailable() {
  const host = normalizeHostname(window.location.hostname);
  return isLocalHostName(host) || isPrivateLanHost(host);
}

export function isLocalHostName(host) {
  return ["127.0.0.1", "localhost", "::1"].includes(normalizeHostname(host));
}

function safeAndroidReturnUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.protocol === "capacitor:") return url.toString();
    const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
    if ((url.protocol === "http:" || url.protocol === "https:") && localHosts.has(url.hostname)) return url.toString();
  } catch {}
  return "";
}

function fallbackReturnToClient(returnTo) {
  const target = returnTo || "capacitor://localhost/";
  try {
    window.location.replace(target);
  } catch {
    window.location.href = target;
  }
}

function normalizeHostname(host) {
  return String(host || "").trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
}

function isPrivateLanHost(host) {
  const value = normalizeHostname(host);
  if (value.endsWith(".local")) return true;
  if (value.startsWith("fe80:") || (value.includes(":") && (value.startsWith("fc") || value.startsWith("fd")))) return true;
  const match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) return false;
  const first = Number(match[1]);
  const second = Number(match[2]);
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168) || (first === 169 && second === 254);
}
