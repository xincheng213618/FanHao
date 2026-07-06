export function createAdminScriptService({
  definitions,
  hasPerson,
  nodeCommand = process.execPath
}) {
  function byId(scriptId) {
    return definitions.find((script) => script.id === scriptId) || null;
  }

  function publicField(field) {
    return {
      name: field.name,
      label: field.label,
      type: field.type,
      flag: field.flag || "",
      positional: Boolean(field.positional),
      default: field.default ?? "",
      placeholder: field.placeholder || "",
      help: field.help || "",
      required: Boolean(field.required),
      min: field.min ?? null,
      max: field.max ?? null,
      step: field.step ?? null,
      options: Array.isArray(field.options) ? field.options.map((option) => ({ ...option })) : []
    };
  }

  function risk(script) {
    if (script.risk) return script.risk;
    const category = script.category || "";
    if (category === "验证" || category === "报表") return "safe";
    if (category === "维护" || /清理|覆盖|删除/.test(`${script.title} ${script.description}`)) return "danger";
    if ((script.fields || []).some((field) => field.flag === "--write" && field.default === false)) return "danger";
    if ((script.fields || []).some((field) => field.flag === "--overwrite" || field.flag === "--force" || field.flag === "--delete-zero-byte")) return "careful";
    if ((script.invalidates || []).length) return "write";
    return "normal";
  }

  function riskLabel(value) {
    return {
      safe: "安全",
      normal: "常规",
      write: "写入",
      careful: "谨慎",
      danger: "高风险"
    }[value] || "常规";
  }

  function publicScript(script) {
    const scriptRisk = risk(script);
    return {
      id: script.id,
      title: script.title,
      category: script.category,
      description: script.description,
      runtime: script.runtime,
      script: script.script,
      risk: scriptRisk,
      riskLabel: riskLabel(scriptRisk),
      invalidates: [...(script.invalidates || [])],
      refreshHints: [...(script.refreshHints || [])],
      fields: (script.fields || []).map(publicField)
    };
  }

  function categories() {
    return [...new Set(definitions.map((script) => script.category || "其他"))];
  }

  function normalizeListValue(value) {
    const rawItems = Array.isArray(value)
      ? value
      : String(value || "")
          .split(/\r?\n|,/)
          .map((item) => item.trim());
    const seen = new Set();
    const result = [];
    for (const item of rawItems) {
      const text = String(item || "").trim();
      if (!text || text.length > 1000 || seen.has(text)) continue;
      seen.add(text);
      result.push(text);
      if (result.length >= 100) break;
    }
    return result;
  }

  function normalizeNumberValue(value, field) {
    if (value === null || value === undefined || String(value).trim() === "") {
      return field.default === "" || field.default === undefined ? "" : field.default;
    }
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return field.default === "" || field.default === undefined ? "" : field.default;
    }
    const min = Number.isFinite(Number(field.min)) ? Number(field.min) : Number.MIN_SAFE_INTEGER;
    const max = Number.isFinite(Number(field.max)) ? Number(field.max) : Number.MAX_SAFE_INTEGER;
    const clamped = Math.max(min, Math.min(max, number));
    return Number(field.step) && Number(field.step) < 1 ? clamped : Math.floor(clamped);
  }

  function normalizeFieldValue(field, input) {
    const value = input[field.name] ?? field.default ?? "";
    if (field.type === "checkbox") return Boolean(value);
    if (field.type === "number") return normalizeNumberValue(value, field);
    if (field.type === "textarea-list") return normalizeListValue(value);
    if (field.type === "select") {
      const allowed = (field.options || []).map((option) => option.value);
      const selected = String(value || field.default || "");
      return allowed.includes(selected) ? selected : allowed[0] || "";
    }
    if (field.type === "person") {
      const personId = String(value || "").trim();
      if (!personId) {
        if (field.required) {
          const error = new Error(`${field.label || "人物"}不能为空`);
          error.statusCode = 400;
          throw error;
        }
        return "";
      }
      if (!hasPerson(personId)) {
        const error = new Error("选择的人物不存在");
        error.statusCode = 400;
        throw error;
      }
      return personId;
    }
    const text = String(value || "").trim().slice(0, field.maxLength || 4000);
    if (field.required && !text) {
      const error = new Error(`${field.label || field.name}不能为空`);
      error.statusCode = 400;
      throw error;
    }
    return text;
  }

  function normalizeOptions(script, input = {}) {
    const options = {};
    for (const field of script.fields || []) {
      options[field.name] = normalizeFieldValue(field, input);
    }
    return options;
  }

  function appendFieldArgs(args, field, value) {
    if (field.type === "checkbox") {
      if (value && field.flag) args.push(field.flag);
      return;
    }
    if (field.type === "textarea-list") {
      for (const item of Array.isArray(value) ? value : []) {
        if (field.flag) args.push(field.flag, item);
        else args.push(item);
      }
      return;
    }
    if (value === "" || value === null || value === undefined) return;
    if (field.positional) {
      args.push(String(value));
      return;
    }
    if (field.flag) args.push(field.flag, String(value));
  }

  function buildCommand(script, options) {
    const args = [];
    if (script.runtime === "python") {
      args.push("-u", script.script);
    } else if (script.runtime === "node") {
      args.push(script.script);
    } else {
      const error = new Error(`不支持的脚本运行时：${script.runtime}`);
      error.statusCode = 400;
      throw error;
    }

    for (const field of script.fields || []) {
      appendFieldArgs(args, field, options[field.name]);
    }

    return {
      command: script.runtime === "python" ? "python" : nodeCommand,
      args
    };
  }

  return {
    buildCommand,
    byId,
    categories,
    definitions,
    normalizeOptions,
    publicScript
  };
}
