import { bootStandaloneApp } from "./js/standalone-host.js?v=20261004-reader-navigation-owner-06";

document.documentElement.dataset.appModule = "standalone";
await bootStandaloneApp();
