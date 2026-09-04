#!/usr/bin/env node
/**
 * deploybudget
 * Apply a production-only Vercel git configuration across one or many projects.
 *
 * dfklabs — https://dfklabs.com
 * Paneltir — https://paneltir.dfklabs.com
 *
 * Copyright 2026 dfklabs
 * SPDX-License-Identifier: Apache-2.0
 *
 * Licensed under the Apache License, Version 2.0. You may obtain a copy of
 * the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * The Vercel configuration templates shipped alongside this script
 * (vercel.json, templates/*.json) are public domain under CC0 1.0 and carry
 * no attribution requirement. See NOTICE.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative, basename } from 'node:path';

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.vercel',
  '.turbo',
  'dist',
  'build',
  'out',
  'coverage',
  '.cache',
  'vendor',
]);

const USAGE = `
deploybudget — stop Vercel burning your daily deployment limit

Usage
  node apply.mjs [path]              Apply to a single project (default: ".")
  node apply.mjs --scan <path>       Apply to every project found under <path>

Options
  --branch <name>      Production branch that stays enabled   (default: "main")
  --allow <name>       Additional branch to keep enabled      (repeatable)
  --depth <n>          Max scan depth when using --scan       (default: 3)
  --force              Remove existing rules that still allow other branches
  --dry-run            Print the planned changes, write nothing
  --backup             Save vercel.json.bak before overwriting
  --help               Show this message

Examples
  node apply.mjs ./my-app
  node apply.mjs --scan ~/code --dry-run
  node apply.mjs --scan ~/code --branch master --allow staging --backup

Docs and updates
  https://github.com/dfklabs/deploybudget
  https://paneltir.dfklabs.com
`.trim();

/** Read the value that follows a flag, failing loudly when it is missing. */
function optionValue(argv, index, flag) {
  const value = argv[index];
  if (value === undefined || value.startsWith('-')) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function parseArgs(argv) {
  const opts = {
    target: null,
    scan: null,
    branch: 'main',
    allow: [],
    depth: 3,
    force: false,
    dryRun: false,
    backup: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--help':
      case '-h':
        opts.help = true;
        break;
      case '--force':
        opts.force = true;
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--backup':
        opts.backup = true;
        break;
      case '--scan':
        opts.scan = optionValue(argv, ++i, '--scan');
        break;
      case '--branch':
        opts.branch = optionValue(argv, ++i, '--branch');
        break;
      case '--allow':
        opts.allow.push(optionValue(argv, ++i, '--allow'));
        break;
      case '--depth':
        opts.depth = Number(optionValue(argv, ++i, '--depth'));
        break;
      default:
        if (arg.startsWith('-')) {
          throw new Error(`Unknown option: ${arg}`);
        }
        opts.target = arg;
    }
  }

  if (opts.scan && opts.target) {
    throw new Error('Pass either a path or --scan, not both.');
  }
  if (!opts.branch) {
    throw new Error('--branch requires a branch name.');
  }
  if (!Number.isInteger(opts.depth) || opts.depth < 0) {
    throw new Error('--depth must be a non-negative integer.');
  }
  if (opts.allow.some((b) => !b)) {
    throw new Error('--allow requires a branch name.');
  }

  return opts;
}

/** A directory is treated as a project when it holds a package.json or a vercel.json. */
function isProject(dir) {
  return existsSync(join(dir, 'package.json')) || existsSync(join(dir, 'vercel.json'));
}

function findProjects(root, maxDepth) {
  const found = [];

  function walk(dir, depth) {
    if (depth > maxDepth) return;

    if (isProject(dir)) {
      found.push(dir);
      // A project's own subdirectories are still worth scanning for monorepo packages,
      // but only one level further so we do not descend through every workspace.
      if (depth >= maxDepth) return;
    }

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), depth + 1);
    }
  }

  walk(resolve(root), 0);
  return found;
}

function detectIndent(raw) {
  const match = raw.match(/\n([ \t]+)"/);
  if (!match) return 2;
  return match[1].includes('\t') ? '\t' : match[1].length;
}

function buildRules(existing, branch, allow, force) {
  const enabled = [branch, ...allow];
  // Start from what is already there so unrelated branch rules survive.
  const rules = { ...existing, '*': false };
  if (force) {
    // Drop any leftover rule that would still let another branch deploy.
    for (const [pattern, value] of Object.entries(rules)) {
      if (value === true && !enabled.includes(pattern)) delete rules[pattern];
    }
  }
  for (const name of enabled) {
    rules[name] = true;
  }
  // Put the wildcard first so the file reads top-down: deny all, then allow.
  const ordered = { '*': false };
  for (const [key, value] of Object.entries(rules)) {
    if (key !== '*') ordered[key] = value;
  }
  return { rules: ordered, enabled };
}

function planFor(dir, opts) {
  const file = join(dir, 'vercel.json');
  const plan = { dir, file, warnings: [], created: !existsSync(file) };

  let config = {};
  let indent = 2;
  let trailingNewline = true;

  if (!plan.created) {
    const raw = readFileSync(file, 'utf8');
    indent = detectIndent(raw);
    trailingNewline = raw.endsWith('\n');
    try {
      config = JSON.parse(raw);
    } catch (error) {
      plan.error = `vercel.json is not valid JSON (${error.message})`;
      return plan;
    }
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
      plan.error = 'vercel.json does not contain a JSON object';
      return plan;
    }
    plan.before = raw;
  }

  const git = { ...(config.git ?? {}) };
  const previous = git.deploymentEnabled;

  if (previous === false) {
    plan.warnings.push(
      'deploymentEnabled was false (all automatic deploys off); replacing it with a production-only rule',
    );
  }

  const existingRules =
    previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {};

  const { rules, enabled } = buildRules(existingRules, opts.branch, opts.allow, opts.force);

  for (const [pattern, value] of Object.entries(existingRules)) {
    if (value === true && !enabled.includes(pattern)) {
      plan.warnings.push(
        opts.force
          ? `removed rule "${pattern}": true, which allowed deployments outside production`
          : `rule "${pattern}": true is kept and will still allow deployments — rerun with --force to remove it`,
      );
    }
  }

  git.deploymentEnabled = rules;

  // Rebuild the object so $schema stays on top, then the original keys in order.
  const next = { $schema: config.$schema ?? 'https://openapi.vercel.sh/vercel.json' };
  for (const [key, value] of Object.entries(config)) {
    if (key !== '$schema' && key !== 'git') next[key] = value;
  }
  next.git = git;

  plan.after = JSON.stringify(next, null, indent) + (trailingNewline ? '\n' : '');
  plan.changed = plan.created || plan.after !== plan.before;
  plan.rules = rules;
  return plan;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    process.exit(1);
  }

  if (opts.help) {
    console.log(USAGE);
    return;
  }

  const root = resolve(opts.scan ?? opts.target ?? '.');

  if (!existsSync(root) || !statSync(root).isDirectory()) {
    console.error(`Not a directory: ${root}`);
    process.exit(1);
  }

  const projects = opts.scan ? findProjects(root, opts.depth) : [root];

  if (projects.length === 0) {
    console.error(`No projects found under ${root}`);
    process.exit(1);
  }

  const allowed = [opts.branch, ...opts.allow].map((b) => `"${b}"`).join(', ');
  console.log(`Production-only Vercel config — deploying branches: ${allowed}`);
  console.log(`Scope: ${projects.length} project${projects.length === 1 ? '' : 's'} under ${root}`);
  if (opts.dryRun) console.log('Mode: dry run (nothing will be written)');
  console.log('');

  let written = 0;
  let skipped = 0;
  let failed = 0;

  for (const dir of projects) {
    const label = relative(root, dir) || basename(dir);
    const plan = planFor(dir, opts);

    if (plan.error) {
      console.log(`  ✗ ${label} — ${plan.error}`);
      failed++;
      continue;
    }

    for (const warning of plan.warnings) {
      console.log(`  ! ${label} — ${warning}`);
    }

    if (!plan.changed) {
      console.log(`  · ${label} — already production-only`);
      skipped++;
      continue;
    }

    const verb = plan.created ? 'create' : 'update';

    if (opts.dryRun) {
      console.log(`  → ${label} — would ${verb} vercel.json`);
      written++;
      continue;
    }

    try {
      if (opts.backup && !plan.created) {
        writeFileSync(`${plan.file}.bak`, plan.before, 'utf8');
      }
      writeFileSync(plan.file, plan.after, 'utf8');
      console.log(`  ✓ ${label} — ${verb}d vercel.json`);
      written++;
    } catch (error) {
      console.log(`  ✗ ${label} — ${error.message}`);
      failed++;
    }
  }

  console.log('');
  const changeLabel = opts.dryRun ? 'to change' : 'changed';
  console.log(`${written} ${changeLabel}, ${skipped} already correct, ${failed} failed`);

  if (!opts.dryRun && written > 0) {
    console.log('');
    console.log('Commit the files and push to your production branch to activate them.');
  }

  process.exit(failed > 0 ? 1 : 0);
}

main();
