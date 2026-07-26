import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const MAX_PROCESS_OUTPUT_BYTES = 2 * 1024 * 1024;

export function createNovelReimportService({
  collectionService,
  dbPath,
  novelStore,
  projectRoot,
  pythonPath = "python",
  spawnProcess = spawn
} = {}) {
  if (!collectionService) throw new Error("novel reimport collectionService is required");
  if (!dbPath) throw new Error("novel reimport dbPath is required");
  if (!novelStore) throw new Error("novel reimport novelStore is required");
  const root = path.resolve(projectRoot || process.cwd());
  const scriptPath = path.join(root, "tools", "rescan_novel_library.py");

  async function reimport(bookId, body = {}) {
    const current = novelStore.bookMeta(bookId)?.book;
    if (!current) return null;

    if (hasTextPayload(body)) {
      const imported = novelStore.reimportBook(bookId, body);
      if (!imported) return null;
      return {
        kind: "book",
        book: imported.book,
        message: `重新导入完成：${imported.book.chapterCount} 章`
      };
    }

    const sourcePath = String(current.sourcePath || "");
    if (sourcePath.startsWith("collector://")) {
      const sourceUrl = String(current.relativePath || "").trim();
      if (!sourceUrl) throw httpError(400, "这本书没有可用的采集来源网址");
      const queued = collectionService.createTask({
        name: `重新采集：${current.title || "网页小说"}`,
        url: sourceUrl,
        adapterId: "auto",
        mode: "collect"
      });
      return {
        kind: "collection",
        book: current,
        task: queued.task,
        message: "已创建重新采集任务"
      };
    }

    if (sourcePath.startsWith("upload://")) {
      throw httpError(400, "这本书由浏览器上传，请选择 TXT 文件重新导入");
    }

    const local = resolveLocalSource(current);
    novelStore.invalidate();
    await runProcess(
      pythonPath,
      [
        "-u",
        scriptPath,
        "--db",
        path.resolve(dbPath),
        "--file",
        local.sourcePath,
        "--source-root",
        local.sourceRoot,
        "--book-id",
        current.id
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          PYTHONDONTWRITEBYTECODE: "1"
        }
      },
      spawnProcess
    );
    novelStore.invalidate();
    const refreshed = novelStore.bookMeta(bookId)?.book;
    if (!refreshed) throw httpError(500, "重新导入完成后未找到原书记录");
    return {
      kind: "book",
      book: refreshed,
      message: `重新导入完成：${refreshed.chapterCount} 章`
    };
  }

  return { reimport };
}

function hasTextPayload(body) {
  return ["text", "content", "contentBase64", "content_base64"].some((key) => Object.hasOwn(body || {}, key));
}

function resolveLocalSource(book) {
  const sourcePath = String(book.sourcePath || "").trim();
  const sourceRoot = String(book.sourceRoot || "").trim();
  if (!path.isAbsolute(sourcePath)) throw httpError(400, "这本书没有可重新读取的本地 TXT 来源");
  if (!path.isAbsolute(sourceRoot)) throw httpError(400, "这本书的来源目录无效");
  if (!fs.existsSync(sourcePath)) throw httpError(404, "原始 TXT 文件不存在，请检查文件是否已移动");
  if (!fs.existsSync(sourceRoot)) throw httpError(404, "原始 TXT 所在目录不存在");

  const resolvedPath = fs.realpathSync(sourcePath);
  const resolvedRoot = fs.realpathSync(sourceRoot);
  const relative = path.relative(resolvedRoot, resolvedPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw httpError(400, "原始 TXT 不在登记的小说目录内");
  }
  if (path.extname(resolvedPath).toLowerCase() !== ".txt" || !fs.statSync(resolvedPath).isFile()) {
    throw httpError(400, "原始来源不是有效的 TXT 文件");
  }
  return { sourcePath: resolvedPath, sourceRoot: resolvedRoot };
}

function runProcess(command, args, options, spawnProcess) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess(command, args, {
        ...options,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      reject(httpError(500, error.message || "无法启动小说重新导入程序"));
      return;
    }
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    const append = (current, chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_PROCESS_OUTPUT_BYTES) {
        try {
          child.kill();
        } catch {}
        if (!settled) {
          settled = true;
          reject(httpError(500, "小说重新导入输出过大"));
        }
        return current;
      }
      return `${current}${chunk.toString("utf8")}`;
    };
    child.stdout?.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(httpError(500, error.message || "小说重新导入程序启动失败"));
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve(stdout);
        return;
      }
      const detail = String(stderr || stdout || "小说重新导入失败").trim().slice(-800);
      reject(httpError(500, detail));
    });
  });
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
