import { parseWorkCode } from "../../../../../lib/code-parser.js";

const MAX_LOOKUP_LINES = 100;
const MAX_INPUT_LENGTH = 16_000;

function invalidInput(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function lookupLines(input) {
  if (typeof input !== "string" || !input.trim()) throw invalidInput("请粘贴要核对的番号或文件名。");
  if (input.length > MAX_INPUT_LENGTH) throw invalidInput("清单内容过长，请拆成多批核对。");
  const lines = input.split(/\r\n|\n|\r/).map((value, index) => ({ value: value.trim(), line: index + 1 })).filter(({ value }) => value);
  if (lines.length > MAX_LOOKUP_LINES) throw invalidInput("一次最多核对 100 行，请拆成多批。");
  return lines;
}

function parseLookupCode(value) {
  const text = String(value || "").normalize("NFKC");
  // The general filename parser treats leading digits as site noise. Keep
  // joined numeric series prefixes such as 300MIUM distinct in exact lookup.
  const mixedPrefix = /\b(\d{2,6})([a-z]{2,12})[-_.\s]+(\d{2,8}[a-z]?)\b/i.exec(text);
  if (!mixedPrefix) return parseWorkCode(text);
  const [, prefix, letters, number] = mixedPrefix;
  const parsed = parseWorkCode(`${letters}-${number}`);
  return parsed && { ...parsed, code: `${prefix}${parsed.code}`, key: `${prefix}${parsed.key}`, mixedPrefix: true };
}

function reportedCode(work) {
  return work.indexedCode || work.infoSummary?.code || work.code || work.directoryName || work.title;
}

function exactMissingWork(parsed, searchMissing) {
  const candidates = parsed.type === "fc2" ? [parsed.code, parsed.code.replace("-PPV-", "-")] : [parsed.code];
  for (const code of candidates) {
    const match = (searchMissing(code) || []).find((work) => {
      return parseLookupCode(reportedCode(work))?.key === parsed.key;
    });
    if (match) return match;
  }
  return null;
}

export function lookupWorkCodes(input, { localByCodeKey, localByExactCode, searchMissing }) {
  const lines = lookupLines(input);
  const seen = new Set();
  const items = [];
  let local;
  let duplicateCount = 0;
  for (const { value, line } of lines) {
    const parsed = parseLookupCode(value.split(/[\\/]/).at(-1));
    if (!parsed) {
      items.push({ line, status: "invalid" });
      continue;
    }
    if (seen.has(parsed.key)) {
      duplicateCount++;
      continue;
    }
    seen.add(parsed.key);
    local ??= { exact: localByExactCode(), loose: localByCodeKey() };
    const looseWork = parsed.mixedPrefix ? null : local.loose.get(parsed.key);
    const looseCode = looseWork && parseLookupCode(reportedCode(looseWork));
    const localWork = local.exact.get(parsed.key) || (looseCode?.mixedPrefix ? null : looseWork);
    const work = localWork || exactMissingWork(parsed, searchMissing);
    const status = localWork ? "local" : work ? "known" : "unknown";
    items.push({
      line, code: parsed.code, status,
      ...(work ? { title: work.title || "", searchCode: work.indexedCode || work.infoSummary?.code || work.code || parsed.code } : {})
    });
  }
  return { items, duplicateCount };
}
