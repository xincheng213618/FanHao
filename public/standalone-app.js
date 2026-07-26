import { bootStandaloneApp } from "./js/standalone-host.js?v=20260727-initial-route-reveal-01";

document.documentElement.dataset.appModule = "standalone";
await bootStandaloneApp();
