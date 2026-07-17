import { bootStandaloneApp } from "./js/standalone-host.js?v=20260717-photo-library-workspace-01";

document.documentElement.dataset.appModule = "standalone";
await bootStandaloneApp();
