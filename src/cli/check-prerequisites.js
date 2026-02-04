// src/cli/check-prerequisites.js

import fs from 'fs';
import loadProjectBootstrap from '../core/load-project-bootstrap.js';

(async () => {
  const bootstrapPromise = await loadProjectBootstrap();
  const { ENV_FILE } = await bootstrapPromise;

  console.log('🔎 Checking for prerequisite files:');
  console.log('   ENV_FILE:', ENV_FILE);

  const missing = [];

  if (!fs.existsSync(ENV_FILE)) missing.push(ENV_FILE);

  if (missing.length > 0) {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('❌  SETUP FAILED – Missing required file(s):\n');
    missing.forEach(f => console.log(`   ⛔  ${f}`));
    console.log('\n📄  Please place/create the missing file(s).');
    console.log('🛑  Aborting.');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    process.exit(1);
  }

  console.log('\n✅  All prerequisite files are present. 🏁\n');
})();
