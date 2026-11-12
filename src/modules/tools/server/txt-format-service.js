import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { streamStoredZip } from "../../../platform/server/stored-zip-stream.js";

const MAX_BATCH_FILES = 16;

function sanitizeDownloadFileName(value, fallback = "formatted.txt") {
  const raw = String(value || "").replaceAll("\\", "/");
  const name = path
    .basename(raw)
    .replace(/[\x00-\x1f<>:"/\\|?*]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  return (name || fallback).slice(0, 140);
}

function formattedTxtFileName(fileName) {
  const safeName = sanitizeDownloadFileName(fileName, "文本.txt");
  const parsed = path.parse(safeName);
  const base = (parsed.name || "文本").slice(0, 120);
  return `${base}_格式化.txt`;
}

function attachmentDisposition(fileName) {
  const fallback = sanitizeDownloadFileName(fileName, "download.txt").replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${fallback || "download.txt"}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function txtToolOptions(input = {}) {
  return {
    indent: input.indent !== false,
    cleanJunk: input.cleanJunk !== false
  };
}

function txtToolInputBuffer(body = {}) {
  const fileName = sanitizeDownloadFileName(body.fileName || body.name || "文本.txt", "文本.txt");
  if (body.contentBase64) {
    const base64 = String(body.contentBase64 || "").replace(/^data:[^,]+,/, "");
    const buffer = Buffer.from(base64, "base64");
    return { fileName, buffer, source: "file" };
  }
  const text = String(body.text || "");
  return { fileName, buffer: Buffer.from(text, "utf8"), source: "text" };
}

export function createTxtFormatToolService({
  cwd,
  maxBodyBytes,
  maxFileBytes,
  previewBytes,
  sendJson,
  toolDownloadDir,
  ttlMs,
  pythonCommand = "python",
  warn = console.warn
}) {
  const downloads = new Map();
  const timers = new Map();

  function ensureDownloadDir() {
    fs.mkdirSync(toolDownloadDir, { recursive: true });
  }

  function downloadDirForId(id) {
    return path.join(toolDownloadDir, id);
  }

  function removeDownload(id) {
    if (!id) return;
    const timer = timers.get(id);
    if (timer) clearTimeout(timer);
    timers.delete(id);
    const record = downloads.get(id);
    downloads.delete(id);
    if (record?.archiveReaders) { record.removeAfterArchive = true; return; }
    removeDownloadDirectory(record?.dirPath || downloadDirForId(id));
  }

  function removeDownloadDirectory(dir) {
    try {
      const resolved = path.resolve(dir);
      const root = path.resolve(toolDownloadDir);
      if (resolved === root || !resolved.startsWith(root + path.sep)) return;
      fs.rmSync(resolved, { recursive: true, force: true });
    } catch (error) {
      warn("[tool-downloads] 删除临时文件失败：", error.message || error);
    }
  }

  function registerDownload(record) {
    downloads.set(record.id, record);
    const delay = Math.max(0, record.expiresAt - Date.now());
    const timer = setTimeout(() => removeDownload(record.id), delay);
    if (typeof timer.unref === "function") timer.unref();
    timers.set(record.id, timer);
  }

  function cleanup() {
    try {
      fs.rmSync(toolDownloadDir, { recursive: true, force: true });
      ensureDownloadDir();
      downloads.clear();
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    } catch (error) {
      warn("[tool-downloads] 清理临时目录失败：", error.message || error);
    }
  }

  function runFormatter(inputPath, outputPath, options = {}) {
    return new Promise((resolve, reject) => {
      const args = ["-u", path.join("tools", "novel_text_formatter.py"), inputPath, "--output", outputPath];
      if (!options.indent) args.push("--no-indent");
      if (!options.cleanJunk) args.push("--no-clean-junk");

      const child = spawn(pythonCommand, args, {
        cwd,
        windowsHide: true,
        env: {
          ...process.env,
          PYTHONIOENCODING: "utf-8",
          PYTHONUTF8: "1"
        }
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) {
          const error = new Error(stderr.trim() || stdout.trim() || "TXT 格式化失败");
          error.statusCode = 500;
          reject(error);
          return;
        }
        try {
          resolve(JSON.parse(stdout.trim() || "{}"));
        } catch (error) {
          error.statusCode = 500;
          error.message = `格式化统计解析失败：${error.message}`;
          reject(error);
        }
      });
    });
  }

  async function createDownload(body = {}) {
    const options = txtToolOptions(body.options || body);
    const { fileName, buffer, source } = txtToolInputBuffer(body);
    if (!buffer.length) {
      const error = new Error("TXT 内容为空");
      error.statusCode = 400;
      throw error;
    }
    if (buffer.length > maxFileBytes) {
      const error = new Error(`TXT 文件不能超过 ${Math.round(maxFileBytes / 1024 / 1024)} MB`);
      error.statusCode = 413;
      throw error;
    }
    if (source === "file" && path.extname(fileName).toLowerCase() !== ".txt") {
      const error = new Error("只支持 .txt 文档");
      error.statusCode = 400;
      throw error;
    }

    ensureDownloadDir();
    const id = crypto.randomBytes(16).toString("base64url");
    const dirPath = downloadDirForId(id);
    fs.mkdirSync(dirPath, { recursive: true });
    const inputPath = path.join(dirPath, "source.txt");
    const outputFileName = formattedTxtFileName(fileName);
    const outputPath = path.join(dirPath, outputFileName);
    try {
      fs.writeFileSync(inputPath, buffer);
      const stats = await runFormatter(inputPath, outputPath, options);
      fs.rmSync(inputPath, { force: true });
      const outputBuffer = fs.readFileSync(outputPath);
      const now = Date.now();
      const record = {
        id,
        dirPath,
        filePath: outputPath,
        fileName: outputFileName,
        size: outputBuffer.length,
        archiveReaders: 0,
        createdAt: now,
        expiresAt: now + ttlMs
      };
      registerDownload(record);
      const previewText =
        outputBuffer.length <= previewBytes
          ? outputBuffer.toString("utf8")
          : `${outputBuffer.subarray(0, previewBytes).toString("utf8")}\n\n……`;
      return {
        ok: true,
        id,
        fileName: outputFileName,
        size: outputBuffer.length,
        downloadUrl: `/api/tools/txt-format/download/${encodeURIComponent(id)}`,
        expiresAt: new Date(record.expiresAt).toISOString(),
        expiresInSeconds: Math.floor(ttlMs / 1000),
        previewText,
        previewTruncated: outputBuffer.length > previewBytes,
        stats: {
          ...stats,
          input_path: undefined,
          output_path: undefined,
          inputBytes: buffer.length,
          outputBytes: outputBuffer.length
        }
      };
    } catch (error) {
      removeDownload(id);
      throw error;
    }
  }

  function serveDownload(req, res, id) {
    const record = downloads.get(id);
    if (!record) {
      sendJson(res, 404, { error: "下载文件不存在或已过期" });
      return;
    }
    if (Date.now() >= record.expiresAt) {
      removeDownload(id);
      sendJson(res, 410, { error: "下载文件已过期" });
      return;
    }
    if (!fs.existsSync(record.filePath)) {
      removeDownload(id);
      sendJson(res, 404, { error: "下载文件不存在或已过期" });
      return;
    }

    const stat = fs.statSync(record.filePath);
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": stat.size,
      "Content-Disposition": attachmentDisposition(record.fileName),
      "Cache-Control": "no-store"
    });
    fs.createReadStream(record.filePath).pipe(res);
  }

  async function serveBatchDownload(res, ids) {
    if (ids.length < 2 || ids.length > MAX_BATCH_FILES || new Set(ids).size !== ids.length
        || ids.some(id => !/^[A-Za-z0-9_-]{1,80}$/.test(id))) {
      sendJson(res, 400, { error: `请选择 2 至 ${MAX_BATCH_FILES} 份不同的整理结果` });
      return;
    }
    const now = Date.now();
    const records = ids.map(id => downloads.get(id));
    if (records.some(record => !record || now >= record.expiresAt)) {
      sendJson(res, 410, { error: "部分结果已过期，请重新整理后下载" });
      return;
    }

    const files = [], names = new Set();
    try {
      const root = fs.realpathSync(toolDownloadDir);
      for (const record of records) {
        const filePath = fs.realpathSync(record.filePath);
        const expectedStat = fs.statSync(filePath);
        if (filePath !== path.join(root, record.id, record.fileName) || !expectedStat.isFile() || expectedStat.size !== record.size) {
          throw new Error("TXT result was replaced");
        }
        const { name: stem, ext } = path.parse(record.fileName);
        let name = record.fileName;
        for (let suffix = 2; names.has(name.toLowerCase()); suffix++) name = `${stem} (${suffix})${ext}`;
        names.add(name.toLowerCase());
        files.push({ path: filePath, expectedStat, name });
      }
    } catch {
      sendJson(res, 404, { error: "部分整理结果无法读取，请重新整理后下载" });
      return;
    }
    for (const record of records) record.archiveReaders++;
    try {
      res.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Disposition": attachmentDisposition("TXT_整理结果.zip"),
        "Cache-Control": "no-store"
      });
      await streamStoredZip(res, files);
    } finally {
      for (const record of records) {
        record.archiveReaders--;
        if (!record.archiveReaders && record.removeAfterArchive) removeDownloadDirectory(record.dirPath);
      }
    }
  }

  return {
    cleanup,
    createDownload,
    maxBodyBytes,
    serveBatchDownload,
    serveDownload
  };
}
