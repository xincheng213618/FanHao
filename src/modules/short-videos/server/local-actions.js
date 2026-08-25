import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import { ensureRealPathWithinRoots } from "../../../platform/server/library-path-safety.js";

const LOCAL_ACTIONS = new Set(["reveal", "open-author-folder"]);

export function createShortVideoLocalActions({
  roots = [],
  getVideoFile,
  openTarget = openShortVideoLocalTarget,
  delayMs = 25,
  warn = console.warn
} = {}) {
  if (typeof getVideoFile !== "function") {
    throw new TypeError("short-video local actions require getVideoFile");
  }

  const allowedRoots = [...new Set((Array.isArray(roots) ? roots : [])
    .map((root) => String(root || "").trim())
    .filter(Boolean)
    .map((root) => path.resolve(root)))]
    .sort((left, right) => right.length - left.length);

  function sourceFile(id) {
    const videoId = String(id || "").trim();
    const file = videoId ? getVideoFile(videoId, { allowMissing: true }) : null;
    if (!file?.path) throw localActionError("没有找到本地原文件", 404, "SHORT_VIDEO_LOCAL_FILE_NOT_FOUND");

    const sourcePath = path.resolve(file.path);
    const rootPath = allowedRoots.find((root) => isWithinRoot(sourcePath, root));
    if (!rootPath) throw localActionError("原文件不在短视频资料库内", 400, "SHORT_VIDEO_LOCAL_FILE_OUTSIDE_ROOT");
    ensureRealPathWithinRoots(sourcePath, [rootPath], "短视频原文件");

    let stat;
    try {
      stat = fs.statSync(sourcePath);
    } catch {
      throw localActionError("本地原文件不存在", 404, "SHORT_VIDEO_LOCAL_FILE_NOT_FOUND");
    }
    if (!stat.isFile()) throw localActionError("本地原文件不是普通文件", 400, "SHORT_VIDEO_LOCAL_FILE_INVALID");

    return {
      ...file,
      path: sourcePath,
      rootPath,
      relativePath: path.relative(rootPath, sourcePath)
    };
  }

  function resolveAction(id, action) {
    const normalizedAction = String(action || "").trim().toLowerCase();
    if (!LOCAL_ACTIONS.has(normalizedAction)) {
      throw localActionError("本地操作必须是 reveal 或 open-author-folder", 400, "SHORT_VIDEO_LOCAL_ACTION_INVALID");
    }

    const file = sourceFile(id);
    if (normalizedAction === "reveal") {
      return {
        action: normalizedAction,
        targetPath: file.path,
        relativePath: file.relativePath,
        type: "file"
      };
    }

    const relativeParts = file.relativePath.split(path.sep).filter(Boolean);
    if (relativeParts.length < 2 || relativeParts[0] === "..") {
      throw localActionError("当前原文件没有可识别的作者目录", 409, "SHORT_VIDEO_AUTHOR_FOLDER_UNAVAILABLE");
    }
    const targetPath = path.join(file.rootPath, relativeParts[0]);
    ensureRealPathWithinRoots(targetPath, [file.rootPath], "短视频作者目录");
    let stat;
    try {
      stat = fs.statSync(targetPath);
    } catch {
      throw localActionError("作者目录不存在", 404, "SHORT_VIDEO_AUTHOR_FOLDER_NOT_FOUND");
    }
    if (!stat.isDirectory()) {
      throw localActionError("作者目录结构无效", 409, "SHORT_VIDEO_AUTHOR_FOLDER_INVALID");
    }
    return {
      action: normalizedAction,
      targetPath,
      relativePath: path.relative(file.rootPath, targetPath),
      type: "folder"
    };
  }

  function schedule(id, action) {
    const target = resolveAction(id, action);
    setTimeout(() => {
      try {
        openTarget({ action: target.action, path: target.targetPath, type: target.type });
      } catch (error) {
        warn("[short-video-local-action]", error?.message || error);
      }
    }, Math.max(0, Number(delayMs) || 0));
    return {
      action: target.action,
      path: target.relativePath.replaceAll(path.sep, "/"),
      type: target.type
    };
  }

  return Object.freeze({ schedule, sourceFile });
}

export function openShortVideoLocalTarget(target = {}) {
  const targetPath = path.resolve(String(target.path || ""));
  const reveal = target.action === "reveal";
  const platform = process.platform;
  const command = platform === "win32"
    ? "explorer.exe"
    : platform === "darwin"
      ? "open"
      : "xdg-open";
  const args = platform === "win32"
    ? [reveal ? `/select,${targetPath}` : targetPath]
    : platform === "darwin"
      ? (reveal ? ["-R", targetPath] : [targetPath])
      : [reveal ? path.dirname(targetPath) : targetPath];
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
}

function isWithinRoot(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function localActionError(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}
