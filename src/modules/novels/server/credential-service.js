import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ALICESW_ID = "alicesw";
const MAX_COOKIE_BYTES = 128 * 1024;

export function createNovelCredentialService({
  credentialRoot,
  pythonPath = "python",
  probePath
} = {}) {
  if (!credentialRoot) throw new Error("novel credentialRoot is required");
  const root = path.resolve(credentialRoot);
  const aliceswCookiePath = path.join(root, "alicesw-cookie.txt");
  const resolvedProbePath = path.resolve(
    probePath || path.join(import.meta.dirname, "..", "collectors", "credential_probe.py")
  );

  function readAliceswCookie() {
    try {
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
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(aliceswCookiePath, cookie, "utf8");
    return aliceswStatus({ saved: true });
  }

  function clearAliceswCookie() {
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

  function testAliceswCookie({ url = "" } = {}) {
    const status = aliceswStatus();
    if (!status.configured) {
      return {
        ok: false,
        message: "尚未配置爱丽丝书屋 Cookie",
        error: "尚未配置爱丽丝书屋 Cookie"
      };
    }
    const normalizedUrl = normalizeAliceswUrl(url);
    let outcome;
    try {
      outcome = spawnSync(
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
          encoding: "utf8",
          windowsHide: true,
          timeout: 90000,
          env: {
            ...process.env,
            PYTHONDONTWRITEBYTECODE: "1",
            PYTHONIOENCODING: "utf-8",
            PYTHONUTF8: "1"
          }
        }
      );
    } catch (error) {
      return {
        ok: false,
        message: "Cookie 检测程序启动失败",
        error: error.message || "Cookie 检测程序启动失败"
      };
    }
    const result = parseProbeResult(outcome.stdout);
    if (result) return result;
    const error = String(outcome.error?.message || outcome.stderr || "").trim();
    return {
      ok: false,
      message: "Cookie 检测没有返回有效结果",
      error: error ? error.slice(0, 500) : "Cookie 检测没有返回有效结果"
    };
  }

  return {
    aliceswStatus,
    clearAliceswCookie,
    readAliceswCookie,
    runnerCredentials,
    saveAliceswCookie,
    statusSummary,
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
