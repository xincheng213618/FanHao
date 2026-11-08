import { bootStandaloneApp } from "./js/standalone-host.js?v=20261108-photo-cover-warm-01";

document.documentElement.dataset.appModule = "standalone";
await bootStandaloneApp();
