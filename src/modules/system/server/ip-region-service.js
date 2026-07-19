import fs from "node:fs";
import net from "node:net";
import {
  IPv4,
  loadContentFromFile,
  newWithBuffer,
  verifyFromFile
} from "ip2region.js";

const UNKNOWN = "未知";

function normalizeRegionField(value) {
  const text = String(value || "").trim();
  return !text || text === "0" ? UNKNOWN : text;
}

export function parseIp2Region(value) {
  const parts = String(value || "").split("|");
  while (parts.length < 5) parts.push("");
  const [country, province, city, isp, isoCode] = parts;
  const normalizedCountry = normalizeRegionField(country);
  return {
    country: normalizedCountry,
    province: normalizeRegionField(province),
    city: normalizeRegionField(city),
    isp: normalizeRegionField(isp),
    isoCode: String(isoCode || "").trim().toUpperCase(),
    located: normalizedCountry !== UNKNOWN
  };
}

function unknownRegion(ipVersion, reason = "") {
  return {
    country: UNKNOWN,
    province: UNKNOWN,
    city: UNKNOWN,
    isp: UNKNOWN,
    isoCode: "",
    located: false,
    ipVersion,
    reason
  };
}

export function createIpRegionService({ xdbPath }) {
  let initialized = false;
  let searcher = null;
  let loadError = "";

  function initialize() {
    if (initialized) return;
    initialized = true;
    try {
      if (!xdbPath || !fs.statSync(xdbPath, { throwIfNoEntry: false })?.isFile()) {
        throw new Error(`找不到 ip2region 数据库：${xdbPath || "未配置"}`);
      }
      verifyFromFile(xdbPath);
      searcher = newWithBuffer(IPv4, loadContentFromFile(xdbPath));
    } catch (error) {
      loadError = error?.message || String(error);
      searcher = null;
      console.warn("[ip2region]", loadError);
    }
  }

  async function lookup(ip) {
    const value = String(ip || "").trim();
    const ipVersion = net.isIP(value);
    if (!ipVersion) return unknownRegion(0, "IP 地址无效");
    if (ipVersion !== 4) return unknownRegion(ipVersion, "当前离线库仅包含 IPv4");
    initialize();
    if (!searcher) return unknownRegion(ipVersion, loadError || "ip2region 未就绪");

    try {
      return {
        ...parseIp2Region(await searcher.search(value)),
        ipVersion,
        reason: ""
      };
    } catch (error) {
      return unknownRegion(ipVersion, error?.message || String(error));
    }
  }

  function status() {
    initialize();
    return {
      ready: Boolean(searcher),
      database: xdbPath || "",
      error: loadError,
      version: "IPv4"
    };
  }

  function close() {
    searcher?.close?.();
    searcher = null;
  }

  return { close, lookup, status };
}
