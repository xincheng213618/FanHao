import { bootStandaloneApp } from "./js/standalone-host.js?v=20260813-tv-series-identity-01";

document.documentElement.dataset.appModule = "standalone";
await bootStandaloneApp();
