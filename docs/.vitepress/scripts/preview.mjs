import { parseArgs } from 'node:util';
import { preview } from 'vite';
import { docsRoot, distRoot } from './content.mjs';
import { deployment } from '../site.mjs';

const { values } = parseArgs({ options: {
  port: { type: 'string', default: '4173' },
  strictPort: { type: 'boolean', default: true }
} });
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Preview port must be between 1 and 65535');
// VitePress 1.x's built-in preview ignores --host and binds all interfaces.
// Use Vite's supported preview API so this documentation server is loopback-only.
const server = await preview({
  configFile: false,
  root: docsRoot,
  base: deployment().base,
  build: { outDir: distRoot },
  preview: { host: '127.0.0.1', port, strictPort: true }
});
server.printUrls();
