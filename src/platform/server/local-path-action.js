import path from "node:path";
import { spawn } from "node:child_process";

export function scheduleLocalPathAction(targetPath, { action = "open", isDirectory = false, warn = console.warn } = {}) {
  setTimeout(() => {
    try {
      const child = runLocalPathAction(targetPath, { action, isDirectory });
      child.once("error", error => warn("[local-path-action]", error?.message || error));
    } catch (error) {
      warn("[local-path-action]", error?.message || error);
    }
  }, 25);
}

export function runLocalPathAction(targetPath, { action = "open", isDirectory = false, platform = process.platform } = {}) {
  const normalizedAction = action === "reveal" ? "reveal" : "open";
  let command = "";
  let args = [];
  let windowsVerbatimArguments = false;

  if (platform === "win32") {
    if (normalizedAction === "reveal") {
      command = "explorer.exe";
      args = [`/select,"${targetPath}"`];
      windowsVerbatimArguments = true;
    } else if (isDirectory) {
      command = "explorer.exe";
      args = [targetPath];
    } else {
      command = "powershell.exe";
      args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "Start-Process -LiteralPath $args[0]", targetPath];
    }
  } else {
    command = platform === "darwin" ? "open" : "xdg-open";
    args = [normalizedAction === "reveal" && !isDirectory ? path.dirname(targetPath) : targetPath];
  }

  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: command !== "explorer.exe",
    windowsVerbatimArguments
  });
  child.unref();
  return child;
}
