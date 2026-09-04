#!/usr/bin/env node
/**
 * deploybudget — release verification
 *
 * Copyright 2026 dfklabs
 * SPDX-License-Identifier: Apache-2.0
 *
 * Checks the invariants that are easy to break by hand and expensive to
 * discover after publishing: version drift between the npm package, the plugin
 * manifest and the skill; config templates that stop matching the wildcard-deny
 * pattern; a build command sneaking into a shared template; a missing license
 * file; a git tag that does not match the version being released.
 *
 * Runs in CI and from `npm run prepublishOnly`. No dependencies.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const problems = [];

function fail(message) {
  problems.push(message);
}

function readJson(relativePath) {
  const absolute = join(ROOT, relativePath);
  if (!existsSync(absolute)) {
    fail(`${relativePath} is missing`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(absolute, 'utf8'));
  } catch (error) {
    fail(`${relativePath} is not valid JSON (${error.message})`);
    return null;
  }
}

// --- Versions line up ------------------------------------------------------

const pkg = readJson('package.json');
const manifest = readJson('.claude-plugin/plugin.json');
const version = pkg?.version;

if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  fail(`package.json version "${version}" is not a semantic version`);
}

if (manifest && manifest.version !== version) {
  fail(`.claude-plugin/plugin.json version "${manifest.version}" != package.json "${version}"`);
}

const skillPath = 'skills/deploybudget/SKILL.md';
const skillAbsolute = join(ROOT, skillPath);

if (!existsSync(skillAbsolute)) {
  fail(`${skillPath} is missing`);
} else {
  const skill = readFileSync(skillAbsolute, 'utf8');
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/);

  if (!frontmatter) {
    fail(`${skillPath} has no YAML frontmatter`);
  } else {
    const block = frontmatter[1];
    if (!/^name:\s*deploybudget\s*$/m.test(block)) {
      fail(`${skillPath} frontmatter must declare "name: deploybudget"`);
    }
    if (!/^description:/m.test(block)) {
      fail(`${skillPath} frontmatter must declare a description`);
    }
    const declared = block.match(/^\s+version:\s*"?([\d.]+)"?\s*$/m);
    if (!declared) {
      fail(`${skillPath} frontmatter must declare metadata.version`);
    } else if (declared[1] !== version) {
      fail(`${skillPath} metadata.version "${declared[1]}" != package.json "${version}"`);
    }
  }

  // The skill is required to warn about PR previews; the whole config turns
  // them off and that is the surprise users report.
  if (!/pull request|PR preview/i.test(skill)) {
    fail(`${skillPath} must state that pull request previews are disabled too`);
  }
}

// --- Plugin manifest -------------------------------------------------------

if (manifest) {
  if (manifest.name !== 'deploybudget') {
    fail(`.claude-plugin/plugin.json name must be "deploybudget", found "${manifest.name}"`);
  }
  for (const field of ['description', 'author', 'homepage', 'repository', 'license']) {
    if (!manifest[field]) fail(`.claude-plugin/plugin.json is missing "${field}"`);
  }
  if (manifest.license !== pkg?.license) {
    fail(`plugin.json license "${manifest.license}" != package.json "${pkg?.license}"`);
  }
}

// --- Config templates ------------------------------------------------------

const BANNED_KEYS = ['buildCommand', 'installCommand', 'devCommand'];

const configs = ['vercel.json', ...readdirSync(join(ROOT, 'templates'))
  .filter((name) => name.endsWith('.json'))
  .map((name) => join('templates', name))];

for (const relativePath of configs) {
  const config = readJson(relativePath);
  if (!config) continue;

  for (const key of BANNED_KEYS) {
    if (key in config) {
      fail(`${relativePath} sets "${key}" — hardcoding it breaks pnpm, yarn and bun projects`);
    }
  }

  if (config.$schema !== 'https://openapi.vercel.sh/vercel.json') {
    fail(`${relativePath} must declare the Vercel $schema`);
  }

  const rules = config.git?.deploymentEnabled;

  if (rules === false) {
    // disable-all.json turns automatic deployments off entirely; that is valid.
    continue;
  }

  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) {
    fail(`${relativePath} must set git.deploymentEnabled to an object or false`);
    continue;
  }

  if (rules['*'] !== false) {
    fail(
      `${relativePath} must deny with "*": false — any branch not named in ` +
        'deploymentEnabled defaults to true, so naming branches does not work',
    );
  }

  if (Object.keys(rules)[0] !== '*') {
    fail(`${relativePath} must list "*": false first so the file reads deny-then-allow`);
  }

  if (!Object.entries(rules).some(([pattern, value]) => pattern !== '*' && value === true)) {
    fail(`${relativePath} allows no branch back — production would never deploy`);
  }
}

// --- Licensing -------------------------------------------------------------

for (const file of ['LICENSE', 'NOTICE', 'templates/LICENSE', 'README.md']) {
  if (!existsSync(join(ROOT, file))) fail(`${file} is missing`);
}

const notice = existsSync(join(ROOT, 'NOTICE')) ? readFileSync(join(ROOT, 'NOTICE'), 'utf8') : '';
if (notice && !/CC0/.test(notice)) {
  fail('NOTICE must record the CC0 exception for the configuration templates');
}

// --- npm packaging ---------------------------------------------------------

if (pkg) {
  for (const entry of pkg.files ?? []) {
    if (!existsSync(join(ROOT, entry))) {
      fail(`package.json "files" lists "${entry}", which does not exist`);
    }
  }
  if (pkg.name?.startsWith('@') && pkg.publishConfig?.access !== 'public') {
    fail('a scoped package needs publishConfig.access = "public" or npm publish fails');
  }
  const bin = typeof pkg.bin === 'string' ? pkg.bin : Object.values(pkg.bin ?? {})[0];
  if (bin && !existsSync(join(ROOT, bin))) {
    fail(`package.json "bin" points at "${bin}", which does not exist`);
  }
  if (bin && !readFileSync(join(ROOT, bin), 'utf8').startsWith('#!')) {
    fail(`${bin} needs a shebang to work as an executable`);
  }
}

// --- Tag matches the version, when running from a tag ----------------------

const ref = process.env.GITHUB_REF ?? '';
if (ref.startsWith('refs/tags/')) {
  const tag = ref.slice('refs/tags/'.length);
  if (tag !== `v${version}`) {
    fail(`tag "${tag}" does not match package.json version "${version}" (expected "v${version}")`);
  }
}

// --- Report ----------------------------------------------------------------

if (problems.length > 0) {
  console.error(`deploybudget release check — ${problems.length} problem(s):\n`);
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  console.error('');
  process.exit(1);
}

console.log(`deploybudget release check — ok (v${version})`);
