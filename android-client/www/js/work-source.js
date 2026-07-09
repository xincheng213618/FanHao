export function getWorkSource(work) {
  const sourcePath = normalizeSourcePath(work?.relativePath);
  if (!sourcePath) return { label: "", variant: "", vr: false };

  if (sourcePath === "v:/[a]" || sourcePath.startsWith("v:/[a]/")) return { label: "VR · V:[A]", variant: "source vr", vr: true };
  if (sourcePath === "v:/[a1]" || sourcePath.startsWith("v:/[a1]/")) return { label: "VR · V:[A1]", variant: "source vr", vr: true };
  if (sourcePath === "v:/av" || sourcePath.startsWith("v:/av/")) return { label: "VR · V:AV", variant: "source vr", vr: true };
  if (sourcePath === "o:/[珍藏]" || sourcePath.startsWith("o:/[珍藏]/")) return { label: "O:珍藏", variant: "source collection", vr: false };
  if (sourcePath === "o:/[珍藏1]" || sourcePath.startsWith("o:/[珍藏1]/")) return { label: "O:珍藏1", variant: "source collection", vr: false };
  if (sourcePath.startsWith("g:/")) return { label: "G:", variant: "source", vr: false };
  if (sourcePath.startsWith("f:/")) return { label: "F:", variant: "source", vr: false };
  if (sourcePath.startsWith("o:/")) return { label: "O:", variant: "source collection", vr: false };
  if (sourcePath.startsWith("v:/")) return { label: "VR", variant: "source vr", vr: true };
  if (sourcePath.startsWith("r:/")) return { label: "欧美 · R:", variant: "source western", vr: false };
  return { label: "", variant: "", vr: false };
}

export function isVrWork(work) {
  return getWorkSource(work).vr || titleSuggestsVr(work);
}

function normalizeSourcePath(path) {
  return String(path || "")
    .trim()
    .replaceAll("\\", "/")
    .replace(/^([a-zA-Z]):(?!\/)/, "$1:/")
    .toLowerCase();
}

function titleSuggestsVr(work) {
  const text = [work?.title, work?.directoryName]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return text.includes("[vr]") || /\bvr\b/.test(text);
}
