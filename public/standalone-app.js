import { bootStandaloneApp } from "./js/standalone-host.js?v=20261113-txt-append-01";

document.documentElement.dataset.appModule = "standalone";
await bootStandaloneApp();
