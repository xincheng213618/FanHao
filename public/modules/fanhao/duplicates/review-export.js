const HEADERS = ["番号", "分卷", "组标记", "文件名", "文件标记", "大小（字节）", "时长（秒）", "分辨率", "内容校验", "校验完成时间"];
const FILE_MARKS = new Map([["keep", "保留"], ["ignore", "忽略比对"]]);

export function snapshotDuplicateReviews(groups, { isIgnored, getMark, getEvidence }) {
  const rows = [];
  let groupCount = 0;
  for (const group of groups) {
    const ignored = isIgnored(group);
    const files = group.files.map((file) => ({ file, mark: FILE_MARKS.get(getMark(group.id, file)) || "" }));
    if (!ignored && !files.some(({ mark }) => mark)) continue;
    groupCount++;
    const evidence = getEvidence(group);
    for (const { file, mark } of files) {
      const match = evidence?.matches.get(String(file.id));
      rows.push({
        fields: [
          group.code, group.partLabel, ignored ? "忽略本组" : "", file.name, mark,
          file.size, file.duration, file.resolutionLabel, match ? `本次校验内容一致 #${match}` : "",
          match ? evidence.finishedAt : ""
        ],
        path: file.path
      });
    }
  }
  return { groupCount, rows };
}

function csvCell(value) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  const text = String(value ?? "");
  const normalized = text.normalize("NFKC");
  const formula = /^[\r\n\t]|^[\p{White_Space}\u200b\ufeff]*[=+\-@]/u.test(normalized);
  return `"${(formula ? "'" : "") + text.replaceAll('"', '""')}"`;
}

export function serializeDuplicateReviews(rows, includePaths) {
  const header = includePaths ? [...HEADERS, "完整路径"] : HEADERS;
  const lines = [header.map(csvCell).join(",")];
  for (const row of rows) lines.push((includePaths ? [...row.fields, row.path] : row.fields).map(csvCell).join(","));
  return `\ufeff${lines.join("\r\n")}\r\n`;
}

export function downloadDuplicateReviews(rows, includePaths) {
  const csv = serializeDuplicateReviews(rows, includePaths);
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `FanHao-重复文件审阅清单-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
