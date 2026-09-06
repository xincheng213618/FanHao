import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { createAuthServices } from "../../src/platform/server/auth.js";
import { createRequestHandler } from "../../src/platform/server/http-app.js";
import { readBodyText } from "../../src/platform/server/request-io.js";
import { sendJson, sendHtml, sendText, redirect } from "../../src/platform/server/responses.js";

export function createAccountFixture({ now = Date.now } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-accounts-"));
  const dbPath = path.join(root, "accounts.sqlite");
  const auth = createAuthServices({ authSecretPath: path.join(root, "auth-secret.txt"), accountsDbPath: dbPath,
    remoteWebPassword: "", ensureDataDir: () => {}, readBodyText, sendJson, sendHtml, redirect, now });
  const app = createRequestHandler({ ...auth, attachAccessAnalytics() {}, attachAccessLogger() {},
    routeApi(req, res, url) {
      if (url.pathname === "/api/protected") { sendJson(res, 200, { user: auth.requestAuthState(req, url).user || null }); return true; }
      return false;
    }, routeMedia() { return false; }, serveStatic(_req, res, pathname) {
      if (pathname === "/account-protected-fixture") { sendHtml(res, 200, '<!doctype html><html lang="zh-CN"><title>Protected fixture</title><h1>资料库测试页面</h1></html>'); return; }
      sendText(res, 404, "Fixture");
    },
    sendJson, sendHtml, sendText, logError(...args) { console.error(...args); } });
  function handler(req, res) {
    const pathname = new URL(req.url, "http://fixture").pathname;
    if (pathname === "/android-settings-fixture") {
      const html = fs.readFileSync(new URL("../../android-client/www/index.html", import.meta.url), "utf8")
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
        .replaceAll('href="./', 'href="/android/')
        .replace("</body>", '<script type="module" src="/android-account-fixture.js"></script></body>');
      sendHtml(res, 200, html); return;
    }
    if (pathname === "/android-account-fixture") {
      sendHtml(res, 200, `<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Android account fixture</title>
        <link rel="stylesheet" href="/android/platform/accounts/account.css"><body style="margin:16px;background:#f4f6f3"><div id="root" class="account-ui account-embedded"></div>
        <script type="module" src="/android-account-fixture.js"></script></body></html>`); return;
    }
    if (pathname === "/android-account-fixture.js") {
      res.writeHead(200, { "Content-Type": "text/javascript" });
      res.end(`import { createAccountSettings } from '/android/js/account-settings.js';
        import { installServerAuthentication } from '/android/js/server-auth.js';
        const originalFetch = fetch.bind(window); let token = '';
        async function login(path, fields) { const res = await originalFetch(path, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...fields,client:'android'})});
          const result = await res.json(); if (!res.ok) throw new Error(result.error); token=result.token; return result; }
        window.Capacitor={Plugins:{FanHaoAuth:{getSession:async()=>({token}),loginAccount:(fields)=>login('/api/accounts/login',fields),
          registerAccount:(fields)=>login('/api/accounts/register',fields),clearSession:async()=>{token='';}}}};
        installServerAuthentication(()=>location.origin);
        const root=document.getElementById('accountSettingsRoot') || document.getElementById('root');
        if(document.getElementById('settingsOverlay')) { document.querySelector('main').hidden=false; document.getElementById('appStartup').hidden=true;
          document.body.classList.remove('app-starting'); document.getElementById('settingsOverlay').hidden=false;document.body.classList.add('settings-open'); }
        createAccountSettings(root,{serverUrl:location.origin,onSignedIn:()=>{window.signedIn=true},onSignedOut:()=>{window.signedIn=false}});`); return;
    }
    const assets = ["js/account-settings.js", "js/server-auth.js", "js/account-owner.js", "js/api.js", "platform/accounts/account-ui.js", "platform/accounts/account.css"];
    const asset = assets.find((name) => pathname === `/android/${name}`);
    if (asset) {
      res.writeHead(200, { "Content-Type": asset.endsWith(".css") ? "text/css" : "text/javascript" });
      res.end(fs.readFileSync(new URL(`../../android-client/www/${asset}`, import.meta.url))); return;
    }
    if (/^\/android\/(?:styles\.css|css\/[a-z0-9-]+\.css|modules\/[a-z0-9/-]+\.css)$/.test(pathname)) {
      const file = new URL(`../../android-client/www/${pathname.slice("/android/".length)}`, import.meta.url);
      if (fs.existsSync(file)) { res.writeHead(200, { "Content-Type": "text/css" }); res.end(fs.readFileSync(file)); return; }
    }
    return app(req, res);
  }
  let server;
  return { handler, auth, root, dbPath,
    async listen() {
      server = http.createServer(handler);
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      return `http://127.0.0.1:${server.address().port}`;
    },
    async close() {
      if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
      auth.closeAccounts();
      // Nonrecursive cleanup of the known files in this fixture's unique directory.
      for (const name of ["accounts.sqlite", "accounts.sqlite-wal", "accounts.sqlite-shm", "auth-secret.txt"]) {
        const file = path.join(root, name); if (fs.existsSync(file)) fs.unlinkSync(file);
      }
      fs.rmdirSync(root);
    }
  };
}
