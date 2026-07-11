import { bootStandaloneApp } from "./js/standalone-host.js?v=20260712-module-settings-02";

document.documentElement.dataset.appModule = "standalone";
await bootStandaloneApp();
