import { bootStandaloneApp } from "./js/standalone-host.js?v=20260908-novel-library-01";

document.documentElement.dataset.appModule = "standalone";
await bootStandaloneApp();
