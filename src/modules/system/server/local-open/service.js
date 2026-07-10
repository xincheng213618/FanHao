import path from "node:path";
import { spawn } from "node:child_process";

export function createLocalOpenService({
  libraryOpenRoots,
  pathWithinRoot,
  relativeFromRoot,
  safeStat,
  sourcePathToAbsolute,
  warn = console.warn
}) {
  function resolveFolderTarget(sourcePath) {
    const absolutePath = sourcePathToAbsolute(sourcePath);
    if (!absolutePath) {
      return { error: "缺少文件夹路径" };
    }

    const allowed = libraryOpenRoots().some((rootPath) => pathWithinRoot(absolutePath, rootPath));
    if (!allowed) {
      return { error: "只能打开资料库根目录内的文件夹" };
    }

    const stat = safeStat(absolutePath);
    if (!stat) {
      return { error: "本地文件夹不存在" };
    }

    const folderPath = stat.isDirectory() ? absolutePath : path.dirname(absolutePath);
    return { folderPath, relativePath: relativeFromRoot(folderPath) };
  }

  function resolveFileTarget(sourcePath) {
    const absolutePath = sourcePathToAbsolute(sourcePath);
    if (!absolutePath) {
      return { error: "缺少文件路径" };
    }

    const allowed = libraryOpenRoots().some((rootPath) => pathWithinRoot(absolutePath, rootPath));
    if (!allowed) {
      return { error: "只能打开资料库根目录内的文件" };
    }

    const stat = safeStat(absolutePath);
    if (!stat) {
      return { error: "本地文件不存在" };
    }
    if (!stat.isFile()) {
      return { error: "目标不是本地文件" };
    }

    return { filePath: absolutePath, relativePath: relativeFromRoot(absolutePath) };
  }

  function openFolderInSystem(folderPath) {
    const platform = process.platform;
    const command = platform === "win32" ? process.env.ComSpec || "cmd.exe" : platform === "darwin" ? "open" : "xdg-open";
    const args = platform === "win32" ? ["/d", "/c", "start", "", folderPath] : [folderPath];
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.unref();
  }

  function openFileInSystem(filePath) {
    const platform = process.platform;
    const command = platform === "win32" ? "powershell.exe" : platform === "darwin" ? "open" : "xdg-open";
    const args =
      platform === "win32"
        ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "Start-Process -LiteralPath $args[0]", filePath]
        : [filePath];
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.unref();
  }

  function scheduleOpenFolder(folderPath) {
    setTimeout(() => {
      try {
        openFolderInSystem(folderPath);
      } catch (error) {
        warn("[open-folder]", error.message);
      }
    }, 25);
  }

  function scheduleOpenFile(filePath) {
    setTimeout(() => {
      try {
        openFileInSystem(filePath);
      } catch (error) {
        warn("[open-file]", error.message);
      }
    }, 25);
  }

  return {
    resolveFileTarget,
    resolveFolderTarget,
    scheduleOpenFile,
    scheduleOpenFolder
  };
}
