// src/core/bootstrap-factory.js
//
// Projects expose their release config via scripts/bootstrap.js by calling
// makeBootstrap({...}). The returned Promise resolves to a bootstrap object
// consumed by src/cli/release.js and src/cli/deploy.js.

import path from 'path';
import fs from 'fs';
import readline from 'readline';

function parseArgs(argv) {
  const args = argv.slice(2);
  const flags = {
    silent: args.includes('--silent'),
    allowFail: args.includes('--allow-fail'),
    noGit: args.includes('--no-git'),
  };
  const positionalArgs = args.filter(a => !a.startsWith('--'));
  return { args, flags, positionalArgs };
}

async function askChoice(questionText, validChoices, defaultChoice) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const question = (q) => new Promise(resolve => rl.question(q, resolve));

  let choice = null;
  while (!validChoices.includes(choice)) {
    const answer = (await question(questionText)).trim().toLowerCase();
    if (!answer && defaultChoice) {
      choice = defaultChoice;
      break;
    }
    if (validChoices.includes(answer)) {
      choice = answer;
    } else {
      console.log('❌ Invalid choice.');
    }
  }

  rl.close();
  return choice;
}

export default function makeBootstrap(config) {
  const validTargets = config.validTargets ?? ['development', 'testing', 'staging', 'production'];
  const remoteBasePath = config.remoteBasePath;
  if (!remoteBasePath) throw new Error('bootstrap config missing: remoteBasePath');

  const repoBranch = config.repoBranch ?? 'main';
  const distDir = config.distDir ?? 'dist';

  return (async () => {
    const { args, flags, positionalArgs } = parseArgs(process.argv);

    let target = positionalArgs.find(a => validTargets.includes(a)) ?? null;

    const argv1 = (process.argv[1] || '').replaceAll('\\', '/');
    const isReleaseScript = argv1.endsWith('release.js');
    const isDeployScript =
      argv1.endsWith('deploy.js') ||
      argv1.endsWith('deploy.mjs') ||
      argv1.endsWith('deploy.cjs');

    if ((isReleaseScript || isDeployScript) && !target) {
      target = await askChoice(
        `🎯 Target? (${validTargets.join(', ')}): `,
        validTargets,
        config.defaultTarget ?? 'staging'
      );
    }

    const rootDir = process.cwd();
    const packageJsonFile = path.join(rootDir, 'package.json');
    const packageJson = fs.existsSync(packageJsonFile)
      ? JSON.parse(fs.readFileSync(packageJsonFile, 'utf8'))
      : {};

    const envFile = path.join(rootDir, `.env.${target || (config.defaultTarget ?? 'staging')}`);

    const deployItems = (config.deployItems ?? []).map(item => {
      const p = item.path.startsWith('.') || item.path.startsWith('/') || item.path.includes(':')
        ? item.path
        : path.join(rootDir, item.path);

      return {
        path: p,
        isDir: !!item.isDir,
        remoteSubdir: item.remoteSubdir ?? '',
      };
    });

    return {
      ROOT_DIR: rootDir,
      PACKAGE_JSON_FILE: packageJsonFile,
      ENV_FILE: envFile,
      REMOTE_BASE_PATH: remoteBasePath,
      REPO_BRANCH: repoBranch,
      DIST_DIR: path.join(rootDir, distDir),
      args,
      flags,
      target,
      packageJson,
      DEPLOY_ITEMS: deployItems,
    };
  })();
}
