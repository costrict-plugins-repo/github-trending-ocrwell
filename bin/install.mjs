#!/usr/bin/env node
import { mkdir, copyFile, readdir, stat, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const SKILL_NAME = 'ocrwell';
const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR = resolve(HERE, '..', 'skills', SKILL_NAME);

const TARGETS = {
  claude: {
    label: 'Claude Code',
    userDir: () => join(homedir(), '.claude', 'skills', SKILL_NAME),
    projectDir: () => resolve(process.cwd(), '.claude', 'skills', SKILL_NAME),
    reloadHint: 'Start a new Claude Code session (or run /reload) to pick it up.',
  },
  codex: {
    label: 'OpenAI Codex',
    userDir: () => join(homedir(), '.agents', 'skills', SKILL_NAME),
    projectDir: () => resolve(process.cwd(), '.agents', 'skills', SKILL_NAME),
    reloadHint: 'Start a new Codex session and run /skills to confirm ocrwell is listed.',
  },
};

function printUsage() {
  process.stdout.write(`Usage: ocrwell-skill <command> [options]

Commands:
  install      Install the OCRWell skill (default if no command given)
  uninstall    Remove a previously installed OCRWell skill
  help         Show this message

Target (if omitted, you'll be prompted):
  --claude     Target Claude Code  (~/.claude/skills/${SKILL_NAME})
  --codex      Target OpenAI Codex (~/.agents/skills/${SKILL_NAME})
  --both       Target both

Options:
  --project    Operate on the current project instead of user-wide
               (./.claude/skills/${SKILL_NAME} or ./.agents/skills/${SKILL_NAME})
  --force      Overwrite an existing install without prompting
  -h, --help   Show this message

Examples:
  npx @ocrwell/skill install --claude
  npx @ocrwell/skill install --codex --project
  npx @ocrwell/skill install --both
  npx @ocrwell/skill uninstall --codex
`);
}

function parseArgs(argv) {
  const args = {
    command: null,
    targets: new Set(),
    project: false,
    force: false,
    help: false,
  };
  for (const arg of argv) {
    if (arg === '--project') args.project = true;
    else if (arg === '--force' || arg === '-f') args.force = true;
    else if (arg === '--help' || arg === '-h' || arg === 'help') args.help = true;
    else if (arg === '--claude') args.targets.add('claude');
    else if (arg === '--codex') args.targets.add('codex');
    else if (arg === '--both') {
      args.targets.add('claude');
      args.targets.add('codex');
    } else if (arg === 'install' || arg === 'uninstall') {
      if (args.command !== null) {
        throw new Error(`unexpected extra command: ${arg}`);
      }
      args.command = arg;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (args.command === null && !args.help) args.command = 'install';
  return args;
}

async function promptForTargets(action) {
  if (!stdin.isTTY) {
    throw new Error(
      `no target specified — pass --claude, --codex, or --both (stdin is not a TTY, cannot prompt)`
    );
  }
  process.stdout.write(
    `\nWhich tool would you like to ${action} the OCRWell skill for?\n` +
      `  1) Claude Code\n` +
      `  2) OpenAI Codex\n` +
      `  3) Both\n`
  );
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question('Enter choice [1]: ')).trim() || '1';
    if (answer === '1') return new Set(['claude']);
    if (answer === '2') return new Set(['codex']);
    if (answer === '3') return new Set(['claude', 'codex']);
    throw new Error(`invalid choice: ${answer}`);
  } finally {
    rl.close();
  }
}

function targetDir(target, project) {
  const t = TARGETS[target];
  return project ? t.projectDir() : t.userDir();
}

async function copyDir(from, to) {
  await mkdir(to, { recursive: true });
  const entries = await readdir(from, { withFileTypes: true });
  for (const entry of entries) {
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDirectory()) await copyDir(src, dst);
    else if (entry.isFile()) await copyFile(src, dst);
  }
}

async function installOne(target, args) {
  const dest = targetDir(target, args.project);
  const label = TARGETS[target].label;
  if (existsSync(dest)) {
    if (!args.force) {
      process.stderr.write(
        `${label}: already installed at:\n  ${dest}\n\n` +
          `Re-run with --force to overwrite, or uninstall first.\n`
      );
      return false;
    }
    await rm(dest, { recursive: true, force: true });
  }
  await copyDir(SOURCE_DIR, dest);
  process.stdout.write(`Installed OCRWell skill for ${label}:\n  ${dest}\n`);
  return true;
}

async function install(args) {
  if (!existsSync(SOURCE_DIR)) {
    process.stderr.write(
      `Source skill directory missing: ${SOURCE_DIR}\nThis is a packaging bug — please report it.\n`
    );
    process.exit(2);
  }
  const targets = args.targets.size > 0 ? args.targets : await promptForTargets('install');
  let anyFailed = false;
  for (const target of targets) {
    const ok = await installOne(target, args);
    if (!ok) anyFailed = true;
  }
  if (anyFailed) process.exit(1);
  process.stdout.write('\n');
  for (const target of targets) {
    process.stdout.write(`${TARGETS[target].reloadHint}\n`);
  }
}

async function uninstallOne(target, args) {
  const dest = targetDir(target, args.project);
  const label = TARGETS[target].label;
  if (!existsSync(dest)) {
    process.stdout.write(`${label}: nothing to remove at:\n  ${dest}\n`);
    return;
  }
  const info = await stat(dest);
  if (!info.isDirectory()) {
    process.stderr.write(`${label}: refusing to remove non-directory: ${dest}\n`);
    process.exit(1);
  }
  await rm(dest, { recursive: true, force: true });
  process.stdout.write(`${label}: removed OCRWell skill from:\n  ${dest}\n`);
}

async function uninstall(args) {
  const targets = args.targets.size > 0 ? args.targets : await promptForTargets('uninstall');
  for (const target of targets) {
    await uninstallOne(target, args);
  }
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n\n`);
    printUsage();
    process.exit(1);
  }
  if (args.help) {
    printUsage();
    return;
  }
  if (args.command === 'install') return install(args);
  if (args.command === 'uninstall') return uninstall(args);
  printUsage();
  process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
});
