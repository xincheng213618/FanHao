import path from "node:path";

const PROFILES = Object.freeze({
  suite: { id: "suite", title: "FanHao", modules: null, home: "/fanhao", port: 29998 },
  fanhao: { id: "fanhao", title: "番号", modules: ["system", "fanhao"], home: "/fanhao", port: 29997 },
  "short-videos": { id: "short-videos", title: "短视频", modules: ["short-videos"], home: "/short-videos", port: 29996 }
});

export function productProfile(id = "suite") {
  const profile = PROFILES[String(id).trim()];
  if (!profile) throw new Error(`Unknown product: ${id}`);
  return { ...profile, modules: profile.modules ? [...profile.modules] : null };
}

export function productDataDirectory(projectRoot, env = process.env) {
  const profile = productProfile(env.FANHAO_PRODUCT || "suite");
  return path.resolve(env.FANHAO_DATA_DIR || (profile.id === "suite"
    ? path.join(projectRoot, "data")
    : path.join(projectRoot, "data", "products", profile.id)));
}
