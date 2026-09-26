import { spawn } from "node:child_process";

const ACTION_DEFINITIONS = Object.freeze([
  {
    id: "lock",
    label: "锁屏",
    icon: "🔒",
    message: "锁屏指令已发送"
  },
  {
    id: "mute",
    label: "切换静音",
    icon: "🔇",
    message: "音量静音状态切换指令已发送"
  },
  {
    id: "sleep",
    label: "休眠",
    icon: "💤",
    confirm: "确定要让这台电脑进入休眠吗？",
    message: "休眠指令已排队"
  },
  {
    id: "restart",
    label: "重启（60 秒）",
    icon: "🔄",
    kind: "danger",
    confirm: "确定要在 60 秒后重启这台电脑吗？未保存的工作可能丢失。",
    message: "重启指令已发送，将在 60 秒后执行"
  },
  {
    id: "shutdown",
    label: "关机（60 秒）",
    icon: "⏻",
    kind: "danger",
    confirm: "确定要在 60 秒后关闭这台电脑吗？未保存的工作可能丢失。",
    message: "关机指令已发送，将在 60 秒后执行"
  },
  {
    id: "cancel",
    label: "取消关机 / 重启",
    icon: "↩️",
    message: "取消指令已发送"
  }
]);

const ACTION_BY_ID = new Map(ACTION_DEFINITIONS.map((action) => [action.id, action]));

export function createComputerControlService({
  platform = process.platform,
  launch = launchDetached,
  schedule = (callback, delayMs) => setTimeout(callback, delayMs),
  now = () => new Date(),
  warn = console.warn,
  dispatchDelayMs = 250
} = {}) {
  let lastDispatch = null;

  function actionDescriptors() {
    return ACTION_DEFINITIONS
      .filter((action) => commandForAction(action.id, platform))
      .map((action) => descriptorForPlatform(action, platform));
  }

  function status() {
    return {
      ok: true,
      platform,
      platformLabel: platformName(platform),
      actions: actionDescriptors(),
      lastDispatch
    };
  }

  function dispatch(actionId) {
    const id = String(actionId || "").trim().toLowerCase();
    const definition = ACTION_BY_ID.get(id);
    if (!definition) throw controlError("未知的系统控制指令", 400);
    const command = commandForAction(id, platform);
    if (!command) throw controlError(`当前系统不支持“${definition.label}”`, 409);

    const queuedAt = now().toISOString();
    lastDispatch = { action: id, queuedAt };
    const timer = schedule(() => {
      try {
        const child = launch(command.file, command.args);
        child?.once?.("error", (error) => warn(`[computer-control:${id}]`, error.message || error));
      } catch (error) {
        warn(`[computer-control:${id}]`, error.message || error);
      }
    }, dispatchDelayMs);
    timer?.unref?.();

    return {
      ok: true,
      action: id,
      queuedAt,
      message: definition.message
    };
  }

  return Object.freeze({
    actionDescriptors,
    dispatch,
    status
  });
}

export function commandForAction(actionId, platform = process.platform) {
  const commands = PLATFORM_COMMANDS[platform];
  const command = commands?.[String(actionId || "").trim().toLowerCase()];
  return command ? { file: command.file, args: [...command.args] } : null;
}

const PLATFORM_COMMANDS = Object.freeze({
  win32: Object.freeze({
    sleep: command("rundll32.exe", ["powrprof.dll,SetSuspendState", "0,1,0"]),
    lock: command("rundll32.exe", ["user32.dll,LockWorkStation"]),
    mute: command("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-WindowStyle",
      "Hidden",
      "-Command",
      "(New-Object -ComObject WScript.Shell).SendKeys([char]0xAD)"
    ]),
    restart: command("shutdown.exe", ["/r", "/t", "60"]),
    shutdown: command("shutdown.exe", ["/s", "/t", "60"]),
    cancel: command("shutdown.exe", ["/a"])
  }),
  darwin: Object.freeze({
    sleep: command("pmset", ["sleepnow"]),
    lock: command("pmset", ["displaysleepnow"]),
    mute: command("osascript", ["-e", "set volume output muted true"]),
    restart: command("osascript", ["-e", "tell app \"System Events\" to restart"]),
    shutdown: command("osascript", ["-e", "tell app \"System Events\" to shut down"])
  }),
  linux: Object.freeze({
    sleep: command("systemctl", ["suspend"]),
    lock: command("xdg-screensaver", ["lock"]),
    mute: command("amixer", ["-q", "-D", "pulse", "sset", "Master", "mute"]),
    restart: command("shutdown", ["-r", "+1"]),
    shutdown: command("shutdown", ["-h", "+1"]),
    cancel: command("shutdown", ["-c"])
  })
});

function command(file, args) {
  return Object.freeze({ file, args: Object.freeze(args) });
}

function launchDetached(file, args) {
  const child = spawn(file, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

function platformName(platform) {
  if (platform === "win32") return "Windows";
  if (platform === "darwin") return "macOS";
  if (platform === "linux") return "Linux";
  return platform || "未知系统";
}

function descriptorForPlatform(action, platform) {
  if (platform !== "darwin" || !["restart", "shutdown"].includes(action.id)) return { ...action };
  const verb = action.id === "restart" ? "重启" : "关机";
  return {
    ...action,
    label: `${verb}（立即）`,
    confirm: `确定要立即${verb}这台电脑吗？未保存的工作可能丢失。`,
    message: `${verb}指令已发送`
  };
}

function controlError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
