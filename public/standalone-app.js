import { bootStandaloneApp } from "./js/standalone-host.js?v=20261114-remove-tools-01";

document.documentElement.dataset.appModule = "standalone";
await bootStandaloneApp();
