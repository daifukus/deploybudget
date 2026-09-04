/**
 * deploybudget — behaviour tests for apply.mjs
 *
 * Copyright 2026 dfklabs
 * SPDX-License-Identifier: Apache-2.0
 *
 * Every test copies a fixture from test/fixtures into a fresh temporary
 * directory and runs the real CLI against it, so nothing in the repository is
 * mutated and the tests exercise the same code path a user does.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(TEST_DIR, '..');
const APPLY = join(REPO_ROOT, 'apply.mjs');
const FIXTURES = join(TEST_DIR, 'fixtures');

const scratchDirs = [];

process.on('exit', () => {
  for (const dir of scratchDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Copy a fixture into a throwaway directory and return its path. */
function useFixture(name) {
  const dir = mkdtempSync(join(tmpdir(), `deploybudget-${name}-`));
  scratchDirs.push(dir);
  cpSync(join(FIXTURES, name), dir, { recursive: true });
  return dir;
}

/** Run apply.mjs and return { status, stdout, stderr }. */
function run(args, cwd = REPO_ROOT) {
  const result = spawnSync(process.execPath, [APPLY, ...args], {
    cwd,
    encoding: 'utf8',
  });
  assert.equal(result.error, undefined, `spawn failed: ${result.error?.message}`);
  return result;
}

function readConfig(dir) {
  return JSON.parse(readFileSync(join(dir, 'vercel.json'), 'utf8'));
}

function readRaw(dir) {
  return readFileSync(join(dir, 'vercel.json'), 'utf8');
}

test('creates a production-only config in a project that has none', () => {
  const dir = useFixture('clean');
  const { status, stdout } = run([dir]);

  assert.equal(status, 0);
  assert.match(stdout, /create/);

  const config = readConfig(dir);
  assert.equal(config.$schema, 'https://openapi.vercel.sh/vercel.json');
  assert.deepEqual(config.git.deploymentEnabled, { '*': false, main: true });
});

test('writes the wildcard deny rule before the allow rules', () => {
  const dir = useFixture('clean');
  run([dir]);

  const keys = Object.keys(readConfig(dir).git.deploymentEnabled);
  assert.equal(keys[0], '*', 'the "*": false rule must come first so the file reads deny-then-allow');
});

test('merges into an existing vercel.json instead of overwriting it', () => {
  const dir = useFixture('existing-config');
  const { status } = run([dir]);

  assert.equal(status, 0);

  const config = readConfig(dir);
  assert.equal(config.framework, 'nextjs', 'unrelated keys must survive');
  assert.deepEqual(config.regions, ['iad1']);
  assert.deepEqual(config.git.deploymentEnabled, {
    '*': false,
    develop: false,
    main: true,
  });
});

test('preserves the existing indentation and trailing newline', () => {
  const dir = useFixture('existing-config');
  run([dir]);

  const raw = readRaw(dir);
  assert.match(raw, /\n {4}"framework"/, 'four-space indentation must be preserved');
  assert.ok(raw.endsWith('\n'), 'trailing newline must be preserved');
});

test('never adds buildCommand, installCommand or devCommand', () => {
  for (const fixture of ['clean', 'existing-config', 'disabled-all', 'conflicting']) {
    const dir = useFixture(fixture);
    run([dir]);
    const config = readConfig(dir);
    for (const key of ['buildCommand', 'installCommand', 'devCommand']) {
      assert.equal(
        key in config,
        false,
        `${fixture}: ${key} must never be written — it breaks pnpm/yarn/bun projects`,
      );
    }
  }
});

test('reports malformed JSON and leaves the file untouched', () => {
  const dir = useFixture('malformed');
  const before = readRaw(dir);
  const { status, stdout } = run([dir]);

  assert.equal(status, 1, 'a project that cannot be parsed must fail the run');
  assert.match(stdout, /not valid JSON/);
  assert.equal(readRaw(dir), before, 'a malformed file must never be rewritten');
});

test('replaces deploymentEnabled:false with a production-only rule and warns', () => {
  const dir = useFixture('disabled-all');
  const { status, stdout } = run([dir]);

  assert.equal(status, 0);
  assert.match(stdout, /deploymentEnabled was false/);
  assert.deepEqual(readConfig(dir).git.deploymentEnabled, { '*': false, main: true });
});

test('keeps a conflicting true rule and warns about it without --force', () => {
  const dir = useFixture('conflicting');
  const { status, stdout } = run([dir]);

  assert.equal(status, 0);
  assert.match(stdout, /rerun with --force/);

  const rules = readConfig(dir).git.deploymentEnabled;
  assert.equal(rules['preview-*'], true, 'without --force the rule is reported, not removed');
});

test('--force removes the rule that would still allow other branches', () => {
  const dir = useFixture('conflicting');
  const { status, stdout } = run([dir, '--force']);

  assert.equal(status, 0);
  assert.match(stdout, /removed rule "preview-\*"/);

  const rules = readConfig(dir).git.deploymentEnabled;
  assert.equal('preview-*' in rules, false);
  assert.deepEqual(rules, { '*': false, develop: false, main: true });
});

test('is idempotent — a second run reports no change', () => {
  const dir = useFixture('clean');
  run([dir]);
  const after = readRaw(dir);

  const { status, stdout } = run([dir]);
  assert.equal(status, 0);
  assert.match(stdout, /already production-only/);
  assert.equal(readRaw(dir), after, 'a no-op run must not rewrite the file');
});

test('--dry-run writes nothing', () => {
  const dir = useFixture('clean');
  const { status, stdout } = run([dir, '--dry-run']);

  assert.equal(status, 0);
  assert.match(stdout, /dry run/);
  assert.match(stdout, /would create/);
  assert.equal(existsSync(join(dir, 'vercel.json')), false, 'dry run must not create the file');
});

test('--branch and repeated --allow set the enabled branches', () => {
  const dir = useFixture('clean');
  const { status } = run([dir, '--branch', 'master', '--allow', 'staging', '--allow', 'release']);

  assert.equal(status, 0);
  assert.deepEqual(readConfig(dir).git.deploymentEnabled, {
    '*': false,
    master: true,
    staging: true,
    release: true,
  });
});

test('--backup saves the original next to the rewritten file', () => {
  const dir = useFixture('existing-config');
  const before = readRaw(dir);
  const { status } = run([dir, '--backup']);

  assert.equal(status, 0);
  assert.equal(readFileSync(join(dir, 'vercel.json.bak'), 'utf8'), before);
  assert.notEqual(readRaw(dir), before);
});

test('--backup does not write a .bak when the file is being created', () => {
  const dir = useFixture('clean');
  run([dir, '--backup']);
  assert.equal(existsSync(join(dir, 'vercel.json.bak')), false);
});

test('--scan finds nested projects and skips node_modules', () => {
  const dir = useFixture('monorepo');
  const { status, stdout } = run(['--scan', dir]);

  assert.equal(status, 0);
  assert.match(stdout, /apps\/web/);
  assert.match(stdout, /apps\/docs/);
  assert.doesNotMatch(stdout, /should-be-ignored/, 'node_modules must never be scanned');

  for (const project of ['.', 'apps/web', 'apps/docs']) {
    assert.deepEqual(readConfig(join(dir, project)).git.deploymentEnabled, {
      '*': false,
      main: true,
    });
  }
  assert.equal(
    existsSync(join(dir, 'node_modules/should-be-ignored/vercel.json')),
    false,
  );
});

test('--depth 0 limits the scan to the root project', () => {
  const dir = useFixture('monorepo');
  const { status, stdout } = run(['--scan', dir, '--depth', '0']);

  assert.equal(status, 0);
  assert.doesNotMatch(stdout, /apps\/web/);
  assert.equal(existsSync(join(dir, 'apps/web/vercel.json')), false);
});

test('--help exits cleanly and documents every option', () => {
  const { status, stdout } = run(['--help']);

  assert.equal(status, 0);
  for (const flag of ['--scan', '--branch', '--allow', '--depth', '--force', '--dry-run', '--backup']) {
    assert.ok(stdout.includes(flag), `usage must document ${flag}`);
  }
});

test('rejects an unknown option', () => {
  const { status, stderr } = run(['--nope']);
  assert.equal(status, 1);
  assert.match(stderr, /Unknown option: --nope/);
});

test('rejects a path and --scan together', () => {
  const { status, stderr } = run(['.', '--scan', '.']);
  assert.equal(status, 1);
  assert.match(stderr, /not both/);
});

test('rejects --branch, --allow, --scan and --depth without a value', () => {
  for (const args of [['--branch'], ['--allow'], ['--scan'], ['--depth']]) {
    const { status, stderr } = run(args);
    assert.equal(status, 1, `${args[0]} without a value must fail`);
    assert.match(stderr, /requires|must be/);
  }
});

test('fails on a path that is not a directory', () => {
  const { status, stderr } = run([join(REPO_ROOT, 'README.md')]);
  assert.equal(status, 1);
  assert.match(stderr, /Not a directory/);
});
