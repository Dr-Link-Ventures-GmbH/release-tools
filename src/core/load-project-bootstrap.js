// src/core/load-project-bootstrap.js

import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

export default async function loadProjectBootstrap() {
  const rootDir = process.cwd();
  const bootstrapPath = path.join(rootDir, 'scripts', 'bootstrap.js');

  if (!fs.existsSync(bootstrapPath)) {
    console.error('❌ Project bootstrap not found:', bootstrapPath);
    console.error('📄 Expected: <project-root>/scripts/bootstrap.js');
    process.exit(1);
  }

  const mod = await import(pathToFileURL(bootstrapPath).href);
  const bootstrapPromise = mod.default;

  if (!bootstrapPromise || typeof bootstrapPromise.then !== 'function') {
    console.error('❌ Project bootstrap export is not a Promise. Expected default export = Promise.');
    process.exit(1);
  }

  return bootstrapPromise;
}
