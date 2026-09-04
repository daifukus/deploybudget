<h1 align="center">deploybudget</h1>

<p align="center">
  <strong>Stop Vercel from burning your daily deployment limit on branches nobody looks at.</strong>
  <br>
  Fixes <em>&quot;Deployment rate limited &mdash; retry in 24 hours&quot;</em>.
</p>

<p align="center">
  <a href="https://github.com/dfklabs/deploybudget/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/dfklabs/deploybudget/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Zero dependencies" src="https://img.shields.io/badge/dependencies-0-brightgreen">
  <img alt="Node 18 or newer" src="https://img.shields.io/badge/node-%E2%89%A5%2018-brightgreen">
  <a href="#license"><img alt="Apache-2.0, templates CC0" src="https://img.shields.io/badge/license-Apache--2.0%20%C2%B7%20templates%20CC0-blue"></a>
</p>

<p align="center">
  <a href="https://dfklabs.com">dfklabs</a>
  &nbsp;&middot;&nbsp;
  <a href="https://paneltir.dfklabs.com">Paneltir</a>
  &nbsp;&middot;&nbsp;
  <a href="#quick-start">Quick start</a>
  &nbsp;&middot;&nbsp;
  <a href="#the-gotcha-most-people-hit">The gotcha</a>
  &nbsp;&middot;&nbsp;
  <a href="./skills/deploybudget/references/vercel-git-config.md">Config reference</a>
</p>

---

By default, Vercel builds **every branch you push**. On a hobby or small team plan
that is how you end up staring at this:

```
Deployment rate limited — retry in 24 hours
```

This repo is a drop-in `vercel.json` (plus a script to apply it across every
project you own) that limits automatic deployments to your production branch.

---

## The gotcha most people hit

The obvious config looks like this — and it does **not** work:

```jsonc
{
  "git": {
    "deploymentEnabled": {
      "main": true,
      "develop": false,
      "staging": false
    }
  }
}
```

Vercel's rule is that **any branch you do not name defaults to `true`**. So
`develop` and `staging` are blocked, but `feature/login`, `fix/typo`, and every
branch you create next month still deploy. The quota keeps draining.

The fix is to deny everything with a wildcard first, then allow production back:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "git": {
    "deploymentEnabled": {
      "*": false,
      "main": true
    }
  }
}
```

`deploymentEnabled` accepts [minimatch](https://github.com/isaacs/minimatch)
patterns, and when a branch matches several rules, **one `true` is enough to
deploy**. `main` matches both `*` (false) and `main` (true), so it deploys.
Everything else matches only `*`, so it does not.

---

## Quick start

Copy [`vercel.json`](./vercel.json) into the root of your project, change `main`
if your production branch is named something else, commit, push.

```bash
curl -O https://raw.githubusercontent.com/dfklabs/deploybudget/main/vercel.json
```

That's the whole thing. The rest of this repo is for people with more than one
project.

---

## Apply it to every project at once

`apply.mjs` has no dependencies and needs only Node 18+. It merges the git config
into each project's existing `vercel.json` instead of overwriting it, and
preserves your indentation.

```bash
# See what would change, touch nothing
node apply.mjs --scan ~/code --dry-run

# Apply it for real, keeping .bak files
node apply.mjs --scan ~/code --backup

# Production branch is master, and staging should deploy too
node apply.mjs --scan ~/code --branch master --allow staging
```

| Option | Description |
| --- | --- |
| `--scan <path>` | Apply to every project found under `<path>` |
| `--branch <name>` | Production branch that stays enabled (default: `main`) |
| `--allow <name>` | Extra branch to keep enabled (repeatable) |
| `--depth <n>` | Max scan depth (default: `3`) |
| `--force` | Remove existing rules that still allow other branches |
| `--dry-run` | Print planned changes, write nothing |
| `--backup` | Save `vercel.json.bak` before overwriting |

A directory counts as a project when it contains a `package.json` or a
`vercel.json`. `node_modules`, `.git`, `.next`, `dist`, and friends are skipped.
Running it twice is safe — the second run reports `already production-only`.

---

## Variants

| File | Behavior |
| --- | --- |
| [`templates/production-only.json`](./templates/production-only.json) | Only `main` deploys |
| [`templates/master-branch.json`](./templates/master-branch.json) | Only `master` deploys |
| [`templates/production-and-staging.json`](./templates/production-and-staging.json) | `main` and `staging` deploy |
| [`templates/disable-all.json`](./templates/disable-all.json) | No automatic deploys at all — CLI only |

---

## What this does and does not do

**It stops** automatic deployments triggered by pushing to any branch other than
the ones you allow. That is where the quota goes.

**It also stops pull request previews.** Preview deployments are triggered by
branch pushes, so a blanket `"*": false` blocks them too. If you want PR previews
but nothing else, leave `deploymentEnabled` alone and use the project's
**Settings → Git** page in the Vercel dashboard instead, which has a separate
control for it. You cannot express "previews only on PRs" in `vercel.json`.

**It does not block manual deploys.** `vercel --prod` and the dashboard's
redeploy button keep working, which is usually what you want as an escape hatch:

```bash
vercel --prod
```

**It deliberately omits `buildCommand`, `installCommand`, and `devCommand`.**
You will see those in copy-pasted snippets, but hardcoding `npm run build` into a
shared template breaks every project using pnpm, yarn, or bun, and overrides the
framework preset Vercel already detected correctly. Set those in the dashboard,
or add them yourself if you actually need to override something.

---

## Why not just use the dashboard?

You can — **Settings → Git** does most of this per project. The tradeoffs:

|  | Dashboard | `vercel.json` |
| --- | --- | --- |
| Version controlled | No | Yes |
| Survives someone else changing it | No | Yes |
| Applies to forks and new clones | No | Yes |
| Per-branch pattern matching | Limited | Full minimatch |
| Bulk apply across projects | One at a time | One command |

`vercel.json` wins once you have more than two or three projects. The dashboard
wins for the one setting it owns exclusively: PR-only previews.

---

## FAQ

**Will this fix a rate limit I already hit?**
No. The 24 hour window has to expire on its own. This prevents the next one.

**Does the config apply before or after the build?**
Before — Vercel reads `vercel.json` from the pushed commit and decides whether to
build at all, so a blocked branch costs you nothing.

**My monorepo has several Vercel projects in one repo.**
`deploymentEnabled` is read per Vercel project from the repo root
`vercel.json`. If your projects have different root directories, put a
`vercel.json` in each root — `apply.mjs --scan` will find them.

**I still see deployments from a branch I blocked.**
Check for a rule that matches it and is `true`; one `true` wins over any number
of `false`. Run `node apply.mjs <project> --force` to strip conflicting rules.

---

## Install

**As a Claude plugin** — this repo is a plugin. Add it from
[Paneltir](https://paneltir.dfklabs.com), or point Claude at this repo directly.
Once installed, just say *"my Vercel quota is maxed out"* and the skill takes
over: it detects your production branch, previews the change, and applies it.

**By hand** — copy [`vercel.json`](./vercel.json) into your project, or clone
this repo and run `apply.mjs` as shown above. No plugin required.

### What the plugin bundles

| Path | What it is |
| --- | --- |
| `.claude-plugin/plugin.json` | Plugin manifest |
| `skills/deploybudget/SKILL.md` | The skill Claude loads |
| `skills/.../references/vercel-git-config.md` | Full `deploymentEnabled` semantics |
| `apply.mjs` | The script the skill runs |
| `templates/*.json` | Ready-made config variants |

---

## Development

No dependencies and no build step. Node 18+ is the only requirement.

```bash
npm test        # behaviour tests for apply.mjs against the fixtures in test/
npm run verify  # release invariants (versions, templates, licensing, packaging)
```

`npm test` runs the real CLI against a copy of each fixture in `test/fixtures`
— a clean project, one with an existing `vercel.json`, malformed JSON,
`deploymentEnabled: false`, a conflicting `true` rule, and a monorepo — so the
tests exercise the same code path a user does and never touch the repository.

`npm run verify` guards what is cheap to break and expensive to discover after
a release: version drift between `package.json`, `.claude-plugin/plugin.json`
and the skill; a template that stops denying with `"*": false` or never allows
production back; a `buildCommand` sneaking into a shared template; a missing
license file; a git tag that does not match the version being released. It runs
in CI and again from `prepublishOnly`.

Both run on Node 18, 20 and 22 in GitHub Actions on every push and pull request.

---

## Support

Free and open source, no strings attached. If it saved you a deployment quota
or an afternoon, a star on the repo is the most useful thing you can do — it is
how other people find it.

- Website — [dfklabs.com](https://dfklabs.com)
- Panel — [paneltir.dfklabs.com](https://paneltir.dfklabs.com)
- Issues — [github.com/dfklabs/deploybudget/issues](https://github.com/dfklabs/deploybudget/issues)

---

## License

Two licenses, on purpose.

| Part | License | What it means for you |
| --- | --- | --- |
| `apply.mjs` and the docs | Apache-2.0 | Use it anywhere, commercially included. Keep the notice, and say so if you modify it. |
| `vercel.json`, `templates/*.json` | CC0-1.0 (public domain) | Copy into your projects freely. **No attribution required.** |

The config files are split out deliberately. They are trivial, purely
functional configuration, and requiring a license header on a file you paste
into your own repo would be absurd — so we waived it outright.

Apache-2.0 grants no trademark rights. "dfklabs" and "Paneltir" are ours; the
code is yours.

See [LICENSE](./LICENSE), [NOTICE](./NOTICE), and
[templates/LICENSE](./templates/LICENSE).

Copyright 2026 [dfklabs](https://dfklabs.com).
