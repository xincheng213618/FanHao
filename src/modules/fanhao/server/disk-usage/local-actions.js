import path from "node:path";
import { spawn } from "node:child_process";

export function scheduleLocalPathAction(targetPath, { action = "open", isDirectory = false, warn = console.warn } = {}) {
  setTimeout(() => {
    try {
      runLocalPathAction(targetPath, { action, isDirectory });
    } catch (error) {
      warn("[disk-usage-open]", error?.message || error);
    }
  }, 25);
}

export function runLocalPathAction(targetPath, { action = "open", isDirectory = false, platform = process.platform } = {}) {
  const normalizedAction = action === "reveal" ? "reveal" : "open";
  let command = "";
  let args = [];

  if (platform === "win32") {
    if (normalizedAction === "reveal") {
      command = "explorer.exe";
      args = [`/select,${targetPath}`];
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
    windowsHide: true
  });
  child.unref();
  return child;
}
