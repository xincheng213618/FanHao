import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const ALICESW_ID = "alicesw";
const MAX_COOKIE_BYTES = 128 * 1024;

export function createNovelCredentialService({
  credentialRoot,
  pythonPath = "python",
  probePath,
  spawnProcess = spawn,
  probeTimeoutMs = 90000,
  maxProbeBytes = 1024 * 1024
} = {}) {
  if (!credentialRoot) throw new Error("novel credentialRoot is required");
  const root = path.resolve(credentialRoot);
  const aliceswCookiePath = path.join(root, "alicesw-cookie.txt");
  const resolvedProbePath = path.resolve(
    probePath || path.join(import.meta.dirname, "..", "collectors", "credential_probe.py")
  );
  let activeProbe = null;
  let stopping = false;
  let lifecycleGeneration = 0;

  function readAliceswCookie() {
    try {
      const stat = fs.statSync(aliceswCookiePath);
      if (!stat.isFile() || stat.size > MAX_COOKIE_BYTES) return "";
      return normalizeCookie(fs.readFileSync(aliceswCookiePath, "utf8"));
    } catch {
      return "";
    }
  }

  function aliceswStatus(extra = {}) {
    let stat = null;
    try {
      stat = fs.statSync(aliceswCookiePath);
    } catch {}
    const cookie = readAliceswCookie();
    const cookieNames = cookieNamesOf(cookie);
    const configured = Boolean(stat?.isFile() && cookie);
    return {
      configured,
      exists: configured,
      label: configured ? "已配置" : "未配置",
      bytes: configured ? Number(stat?.size || 0) : 0,
      updatedAt: configured && stat?.mtime ? stat.mtime.toISOString() : "",
      cookieNames,
      hasLoginCredentials: cookieNames.includes("lf_user_auth") && cookieNames.includes("lf_user_auth_sign"),
      ...extra
    };
  }

  function statusSummary() {
    return {
      alicesw: aliceswStatus()
    };
  }

  function saveAliceswCookie(value) {
    const cookie = normalizeCookie(value);
    const byteLength = Buffer.byteLength(cookie, "utf8");
    if (!cookie || byteLength < 20 || !cookie.includes("=")) {
      throw httpError(400, "Cookie 内容看起来不完整");
    }
    if (byteLength > MAX_COOKIE_BYTES) {
      throw httpError(413, "Cookie 内容过大");
    }
    if (!cookieNamesOf(cookie).includes("server_name_session")) {
      throw httpError(400, "Cookie 缺少 server_name_session，请重新从爱丽丝书屋复制完整 Cookie");
    }
    activeProbe?.controller.abort();
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(aliceswCookiePath, cookie, "utf8");
    return aliceswStatus({ saved: true });
  }

  function clearAliceswCookie() {
    activeProbe?.controller.abort();
    try {
      fs.rmSync(aliceswCookiePath, { force: true });
    } catch (error) {
      throw httpError(500, `清除爱丽丝书屋 Cookie 失败：${error.message || error}`);
    }
    return aliceswStatus({ cleared: true });
  }

  function runnerCredentials(adapterId) {
    if (String(adapterId || "") !== ALICESW_ID || !aliceswStatus().configured) return {};
    return {
      cookieFile: aliceswCookiePath
    };
  }

  async function testAliceswCookie({ url = "", signal: requestedSignal } = {}) {
    const signal = requestedSignal instanceof AbortSignal ? requestedSignal : undefined;
    if (stopping) return probeFailure("Cookie 检测服务正在停止");
    const status = aliceswStatus();
    if (!status.configured) {
      return {
        ok: false,
        message: "尚未配置爱丽丝书屋 Cookie",
        error: "尚未配置爱丽丝书屋 Cookie"
      };
    }
    const normalizedUrl = normalizeAliceswUrl(url);
    if (activeProbe) return probeFailure("已有 Cookie 检测正在运行，请稍后再试");
    if (signal?.aborted) return probeFailure("Cookie 检测已取消");
    const source = cookieStamp();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const task = { controller, done: null };
    activeProbe = task;
    task.done = runProbe(
        pythonPath,
        [
          "-u",
          resolvedProbePath,
          "--cookie-file",
          aliceswCookiePath,
          ...(normalizedUrl ? ["--url", normalizedUrl] : [])
        ],
        {
          cwd: path.dirname(resolvedProbePath),
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            PYTHONDONTWRITEBYTECODE: "1",
            PYTHONIOENCODING: "utf-8",
            PYTHONUTF8: "1"
          }
        }, controller.signal
      ).then((outcome) => {
        if (outcome.error) return probeFailure("Cookie 检测未完成", outcome.error.message);
        if (cookieStamp() !== source) return probeFailure("Cookie 已变化，请重新检测");
        const result = parseProbeResult(outcome.stdout);
        if (result && (!result.ok || outcome.status === 0)) return result;
        return probeFailure("Cookie 检测没有返回有效结果", String(outcome.stderr || "").trim());
      }).finally(() => {
        signal?.removeEventListener("abort", abort);
        if (activeProbe === task) activeProbe = null;
      });
    if (signal?.aborted) abort();
    return task.done;
  }

  function cookieStamp() {
    return crypto.createHash("sha256").update(readAliceswCookie()).digest("hex");
  }

  function runProbe(command, args, options, signal) {
    return new Promise((resolve) => {
      let child;
      try { child = spawnProcess(command, args, options); }
      catch (error) { resolve({ error }); return; }
      const stdout = [], stderr = [];
      let bytes = 0, failure = null, terminating = false;
      const terminate = (error) => {
        failure ||= error;
        if (terminating) return;
        terminating = true;
        try { child.kill("SIGKILL"); } catch {}
      };
      const abort = () => terminate(new Error("Cookie 检测已取消"));
      const timer = setTimeout(() => terminate(new Error("Cookie 检测超时")), probeTimeoutMs);
      const append = (target, chunk) => {
        if (failure) return;
        bytes += chunk.length;
        if (bytes > maxProbeBytes) { terminate(new Error("Cookie 检测输出过大")); return; }
        target.push(chunk);
      };
      child.stdout.on("data", (chunk) => append(stdout, chunk));
      child.stderr.on("data", (chunk) => append(stderr, chunk));
      child.stdout.on("error", terminate);
      child.stderr.on("error", terminate);
      child.once("error", terminate);
      child.once("close", (status) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        resolve({ status, error: failure, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
      });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }

  function beginStop() {
    lifecycleGeneration += 1;
    stopping = true;
    activeProbe?.controller.abort();
    return activeProbe?.done || Promise.resolve();
  }

  async function stop() {
    await beginStop();
  }

  async function start() {
    const generation = lifecycleGeneration;
    if (stopping && activeProbe) await activeProbe.done;
    if (generation !== lifecycleGeneration) return false;
    stopping = false;
    return true;
  }

  function probeFailure(message, detail = "") {
    return {
      ok: false, message,
      error: String(detail || message).slice(0, 500)
    };
  }

  return {
    aliceswStatus,
    beginStop,
    clearAliceswCookie,
    readAliceswCookie,
    runnerCredentials,
    saveAliceswCookie,
    statusSummary,
    start,
    stop,
    testAliceswCookie
  };
}

function normalizeCookie(value) {
  return String(value || "")
    .replace(/^\s*Cookie:\s*/i, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .join("; ")
    .replace(/;\s*;+/g, ";")
    .trim();
}

function cookieNamesOf(cookie) {
  return [...new Set(
    String(cookie || "")
      .split(";")
      .map((part) => part.trim().split("=")[0]?.trim())
      .filter(Boolean)
  )].slice(0, 40);
}

function normalizeAliceswUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw httpError(400, "检测网址无效");
  }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:" || (host !== "alicesw.com" && !host.endsWith(".alicesw.com"))) {
    throw httpError(400, "Cookie 只能用于检测爱丽丝书屋网址");
  }
  parsed.hash = "";
  return parsed.toString();
}

function parseProbeResult(stdout) {
  const lines = String(stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]);
      if (parsed && typeof parsed === "object" && typeof parsed.ok === "boolean") return parsed;
    } catch {}
  }
  return null;
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
