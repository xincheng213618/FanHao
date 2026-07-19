import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAccessAnalyticsService } from "../src/modules/system/server/access-analytics-service.js";
import { createIpRegionService, parseIp2Region } from "../src/modules/system/server/ip-region-service.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const xdbPath = path.join(projectRoot, "data", "ip2region_v4.xdb");

assert.deepEqual(parseIp2Region("中国|江苏省|南京市|电信|CN"), {
  country: "中国",
  province: "江苏省",
  city: "南京市",
  isp: "电信",
  isoCode: "CN",
  located: true
});

const ipRegion = createIpRegionService({ xdbPath });
assert.equal(ipRegion.status().ready, true);
const region = await ipRegion.lookup("114.114.114.114");
assert.equal(region.located, true);
assert.equal(region.country, "中国");
assert.notEqual(region.province, "未知");
assert.equal((await ipRegion.lookup("::1")).located, false);
ipRegion.close();

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-access-analytics-"));
const geo = {
  async lookup(ip) {
    return {
      country: "中国",
      province: ip === "1.2.3.4" ? "广东省" : "江苏省",
      city: "测试市",
      isp: "测试运营商",
      isoCode: "CN",
      located: true,
      ipVersion: 4,
      reason: ""
    };
  },
  status() {
    return { ready: true, database: "test.xdb", error: "", version: "IPv4" };
  },
  close() {}
};

const service = createAccessAnalyticsService({
  dbPath: path.join(tempDir, "access-analytics.sqlite"),
  ensureDataDir() {},
  ipRegionService: geo,
  flushIntervalMs: 60_000
});

function finishRequest({ ip, reason, pathname, status = 200, accept = "text/html", mode = "remote" }) {
  const req = {
    method: "GET",
    headers: {
      accept,
      "sec-fetch-dest": accept.includes("html") ? "document" : "",
      "user-agent": "FanHao access analytics verification"
    }
  };
  const res = new EventEmitter();
  res.statusCode = status;
  res.getHeader = () => 123;
  service.attach(req, res, new URL(pathname, "http://localhost"), {
    access: { clientAddress: ip, mode },
    reason
  });
  res.emit("finish");
}

finishRequest({ ip: "1.2.3.4", reason: "missing-password", pathname: "/fanhao" });
finishRequest({ ip: "1.2.3.4", reason: "password", pathname: "/fanhao" });
finishRequest({ ip: "1.2.3.4", reason: "password", pathname: "/api/library", accept: "application/json" });
finishRequest({ ip: "5.6.7.8", reason: "app", pathname: "/short-videos" });
finishRequest({ ip: "127.0.0.1", reason: "trusted-network", pathname: "/admin", mode: "local" });

const payload = await service.statsPayload(new URL("http://localhost/api/admin/access-stats?days=30&limit=10"));
assert.equal(payload.geo.ready, true);
assert.equal(payload.summary.uniqueIps, 2);
assert.equal(payload.summary.requests, 4);
assert.equal(payload.summary.pageViews, 3);
assert.equal(payload.summary.missingPasswordRequests, 1);
assert.equal(payload.summary.passwordRequests, 2);
assert.equal(payload.summary.injectedRequests, 1);
assert.equal(payload.visitors.length, 3);
assert.equal(payload.provinces[0].province, "广东省");

const passwordOnly = await service.statsPayload(new URL("http://localhost/api/admin/access-stats?days=30&auth=password"));
assert.equal(passwordOnly.summary.uniqueIps, 1);
assert.equal(passwordOnly.summary.requests, 2);
assert.ok(passwordOnly.visitors.every((visitor) => visitor.authReason === "password"));

const provinceOnly = await service.statsPayload(new URL("http://localhost/api/admin/access-stats?days=30&province=江苏省&q=5.6"));
assert.equal(provinceOnly.summary.uniqueIps, 1);
assert.equal(provinceOnly.visitors[0].ip, "5.6.7.8");

const allNetworks = await service.statsPayload(new URL("http://localhost/api/admin/access-stats?days=30&access=all"));
assert.equal(allNetworks.summary.uniqueIps, 3);
assert.equal(allNetworks.summary.trustedNetworkRequests, 1);

await service.close();

const historyPath = path.join(tempDir, "access.log");
fs.writeFileSync(historyPath, [
  JSON.stringify({
    time: new Date(Date.now() - 60_000).toISOString(),
    method: "GET",
    path: "/fanhao",
    status: 200,
    remote: "9.9.9.9",
    access: "remote",
    auth: "password",
    responseLength: 321,
    userAgent: "historical verification"
  }),
  JSON.stringify({
    time: "2999-01-01T00:00:00.000Z",
    method: "GET",
    path: "/future",
    status: 200,
    remote: "10.10.10.10",
    access: "remote",
    auth: "password"
  })
].join("\n"), "utf8");

const bootstrapService = createAccessAnalyticsService({
  dbPath: path.join(tempDir, "access-bootstrap.sqlite"),
  ensureDataDir() {},
  ipRegionService: geo,
  flushIntervalMs: 60_000
});
const firstBootstrap = await bootstrapService.bootstrapFromAccessLogs([historyPath]);
const secondBootstrap = await bootstrapService.bootstrapFromAccessLogs([historyPath]);
const bootstrapped = await bootstrapService.statsPayload(new URL("http://localhost/api/admin/access-stats?days=30"));
assert.equal(firstBootstrap.imported, 1);
assert.equal(secondBootstrap.skipped, true);
assert.equal(bootstrapped.summary.uniqueIps, 1);
assert.equal(bootstrapped.summary.requests, 1);
assert.equal(bootstrapped.visitors[0].ip, "9.9.9.9");
await bootstrapService.close();

fs.rmSync(tempDir, { recursive: true, force: true });
console.log("access analytics verification passed");
