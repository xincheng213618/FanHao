const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.hash.slice(1));
const link = params.get("link") || params.get("magnet") || "";
const code = (params.get("code") || "").slice(0, 80);

function linkScheme(value) {
  if (!value || value.length > 16000 || /[\u0000-\u001f\u007f]/.test(value)) return "";
  if (/^ed2k:\/\/\|file\|[^|]+\|\d+\|[a-f0-9]{32}\|/i.test(value)) return "ed2k://";
  if (/^magnet:\?/i.test(value) && new URLSearchParams(value.slice(8)).getAll("xt").some(Boolean)) return "magnet:";
  return "";
}

const scheme = linkScheme(link);
if (scheme) {
  const address = $("resourceAddress");
  const status = $("resourceStatus");
  const instructions = `按 Ctrl+L、Ctrl+V，在 115 浏览器地址栏选择以 ${scheme} 开头的那一项。`;
  address.textContent = link;
  address.setAttribute("href", link);
  $("openResource").setAttribute("href", link);
  if (code) {
    $("resourceTitle").textContent = `${code} · 交给 115 浏览器`;
    $("catalogLink").href = `/fanhao/ltx?${new URLSearchParams({ q: code })}`;
  }
  $("resourceDetails").hidden = false;
  status.textContent = instructions;
  $("copyResource").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(link);
      status.textContent = `已复制。 ${instructions}`;
    } catch {
      address.focus({ preventScroll: true });
      window.getSelection()?.selectAllChildren(address);
      status.textContent = `已选中地址，请按 Ctrl+C。 ${instructions}`;
    }
  });
} else {
  $("resourceStatus").textContent = "链接无效，请回资源库重新打开。";
}
