import { bootStandaloneApp } from "./js/standalone-host.js?v=20260712-project-refactor-03";

document.documentElement.dataset.appModule = "standalone";
await bootStandaloneApp();
