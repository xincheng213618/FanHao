import fs from "node:fs";
import path from "node:path";

const DEFAULT_TEST_SUBJECT_URL = "https://movie.douban.com/subject/35321946/";
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";

export function createDoubanCookieService({
  cookiePath,
  fetchImpl = fetch,
  testSubjectUrl = DEFAULT_TEST_SUBJECT_URL,
  userAgent = DEFAULT_USER_AGENT
}) {
  function normalize(value) {
    return String(value || "")
      .replace(/^Cookie:\s*/i, "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .join("; ")
      .trim();
  }

  function read() {
    try {
      return normalize(fs.readFileSync(cookiePath, "utf8"));
    } catch {
      return "";
    }
  }

  function status(extra = {}) {
    let stat = null;
    try {
      stat = fs.statSync(cookiePath);
    } catch {}
    const cookie = read();
    return {
      exists: Boolean(stat && cookie),
      filePath: cookiePath,
      bytes: stat?.size || 0,
      updatedAt: stat?.mtime ? stat.mtime.toISOString() : "",
      cookieNames: cookie
        ? cookie
            .split(";")
            .map((part) => part.trim().split("=")[0])
            .filter(Boolean)
            .slice(0, 12)
        : [],
      ...extra
    };
  }

  function save(value) {
    const cookie = normalize(value);
    if (!cookie || cookie.length < 20 || !cookie.includes("=")) {
      const error = new Error("Cookie 内容看起来不完整");
      error.statusCode = 400;
      throw error;
    }
    fs.mkdirSync(path.dirname(cookiePath), { recursive: true });
    fs.writeFileSync(cookiePath, cookie, "utf8");
    return status({ saved: true });
  }

  function isSecurityHtml(finalUrl, html) {
    if (/^https:\/\/sec\.douban\.com\//i.test(finalUrl || "")) return true;
    return /<form[^>]+name=["']sec["']/i.test(html || "") && /sec\.douban\.com|action=["']\/c["']/i.test(html || "");
  }

  async function test(cookie = read()) {
    if (!cookie) {
      const error = new Error("还没有保存豆瓣 Cookie");
      error.statusCode = 400;
      throw error;
    }
    const response = await fetchImpl(testSubjectUrl, {
      headers: {
        "User-Agent": userAgent,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.7",
        Referer: "https://www.douban.com/",
        Cookie: cookie
      }
    });
    const html = await response.text();
    const finalUrl = response.url || testSubjectUrl;
    const title = html
      .match(/<title>([\s\S]*?)<\/title>/i)?.[1]
      ?.replace(/\s+/g, " ")
      .trim() || "";
    const hasSubjectDetail =
      !isSecurityHtml(finalUrl, html) &&
      (html.includes("application/ld+json") || html.includes("v:average") || html.includes("v:summary"));
    return {
      ok: response.ok && hasSubjectDetail,
      status: response.status,
      finalUrl,
      title,
      hasSubjectDetail,
      error: response.ok && hasSubjectDetail ? "" : "Cookie 不能访问豆瓣详情页，可能已过期或需要重新复制。"
    };
  }

  return {
    normalize,
    read,
    save,
    status,
    test
  };
}
