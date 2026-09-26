import path from "node:path";

// Legacy scripts have different path defaults. Only explicitly bound commands
// may run from the standalone product; the suite keeps its existing catalogue.
export function createFanhaoProcessAdapter(config) {
  const scripts = new Set(["full_scan_core_library.py", "refresh_core_javdb_actor_movies.py"]);
  return ({ command, args }) => {
    const script = args.find((value) => /\.(?:py|mjs|js)$/i.test(value));
    const name = path.basename(script || "");
    if (!scripts.has(name)) throw Object.assign(new Error("此旧脚本尚未绑定独立产品的数据目录，请使用整理与迁移界面或综合应用中的脚本入口"), { statusCode: 409 });
    const result = [...args];
    const set = (flag, value) => {
      for (let i = result.length - 1; i >= 0; i--) if (result[i] === flag) result.splice(i, 2);
      result.push(flag, String(value));
    };
    set("--db", config.CORE_DB_PATH);
    if (name === "full_scan_core_library.py") {
      for (let i = result.length - 1; i >= 0; i--) if (result[i] === "--root") result.splice(i, 2);
      for (const root of config.LIBRARY_ROOTS) result.push("--root", root);
    } else set("--profile-dir", path.join(config.DATA_DIR, "collector-browser"));
    return { command: name.endsWith(".py") ? config.PYTHON_PATH : command, args: result,
      env: { ...process.env, FANHAO_CORE_IMAGE_DB: config.CORE_IMAGE_DB_PATH } };
  };
}
