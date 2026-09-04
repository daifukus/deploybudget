---
name: deploybudget
description: >
  This skill should be used when the user wants to stop Vercel from deploying
  every branch, hit a Vercel deployment limit, or says things like "Deployment
  rate limited", "retry in 24 hours", "I ran out of Vercel deployments",
  "only deploy production", "deploy only main", "disable preview deployments",
  "stop deploying every branch", "reduce my Vercel quota usage", or asks to
  configure vercel.json deploymentEnabled or Vercel git settings.
metadata:
  version: "1.0.0"
  author: "dfklabs"
  homepage: "https://paneltir.dfklabs.com"
---

# Vercel production-only deployments

Limit Vercel's automatic deployments to the production branch so branch pushes
stop consuming deployment quota.

## The rule that matters

Vercel treats **any branch not named in `deploymentEnabled` as `true`**. Naming
branches to disable them therefore does not work — new branches keep deploying:

```jsonc
// WRONG — feature/*, fix/*, and every future branch still deploy
{ "git": { "deploymentEnabled": { "main": true, "develop": false } } }
```

Deny everything with a wildcard, then allow production back:

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

`deploymentEnabled` uses minimatch patterns. When a branch matches several
rules, **one `true` is enough to deploy** — so `main` (matching both `*` and
`main`) deploys, and everything else does not.

Never write this config by hand when the bundled script can do it. The script
merges into an existing `vercel.json` instead of overwriting it.

## Procedure

### 1. Determine the production branch

Do not assume `main`. Detect it:

```bash
git -C <project> symbolic-ref --short HEAD 2>/dev/null
git -C <project> remote show origin 2>/dev/null | sed -n 's/.*HEAD branch: //p'
```

If detection is ambiguous or the repo has both `main` and `master`, ask the user
which branch is production before writing anything.

### 2. Preview the change

Always run with `--dry-run` first and show the user the planned changes:

```bash
node "${CLAUDE_PLUGIN_ROOT}/apply.mjs" --scan <path> --dry-run
```

For a single project, pass the path directly instead of `--scan`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/apply.mjs" <path> --dry-run
```

If `${CLAUDE_PLUGIN_ROOT}` is not set, locate the script with
`find . ~ -name apply.mjs -path '*deploybudget*' 2>/dev/null | head -1`.

### 3. Apply

Once the user confirms the file list and the branch:

```bash
node "${CLAUDE_PLUGIN_ROOT}/apply.mjs" --scan <path> --branch <production-branch> --backup
```

Options:

| Option | Effect |
| --- | --- |
| `--scan <path>` | Apply to every project found under `<path>` |
| `--branch <name>` | Production branch to keep enabled (default `main`) |
| `--allow <name>` | Extra branch to keep enabled (repeatable) |
| `--depth <n>` | Max scan depth (default `3`) |
| `--force` | Remove existing rules that still allow other branches |
| `--dry-run` | Print planned changes, write nothing |
| `--backup` | Save `vercel.json.bak` before overwriting |

The script is idempotent — rerunning reports `already production-only`.

### 4. Report

Tell the user, in this order:

1. Which projects changed, and which branch stays deploying.
2. **That PR previews are now off too** (see Limitations). Confirm this is what
   they want; if not, revert and send them to the dashboard instead.
3. That the config only takes effect **after they commit and push it** to the
   production branch.

## Limitations to state explicitly

State these rather than letting the user discover them:

- **PR previews stop as well.** Preview deploys are triggered by branch pushes,
  so `"*": false` blocks them. "Previews only on pull requests" cannot be
  expressed in `vercel.json` at all — it lives in the project's
  **Settings → Git** page in the Vercel dashboard. If the user wants PR previews,
  do not apply this config.
- **An active rate limit does not clear.** The 24-hour window expires on its own.
  This prevents the next one; it does not fix the current one.
- **Manual deploys still work.** `vercel --prod` and the dashboard redeploy
  button are unaffected, which is the intended escape hatch.

## Rules

- Never add `buildCommand`, `installCommand`, or `devCommand` to the config.
  Copy-pasted snippets include them; hardcoding `npm run build` breaks pnpm,
  yarn, and bun projects and overrides the framework preset Vercel already
  detected. Only add them if the user explicitly asks to override a build.
- Never overwrite an existing `vercel.json` wholesale. The script merges; keep it
  that way.
- Use `--force` only after telling the user which rule it will remove.
- In a monorepo, each Vercel project reads the `vercel.json` at its own root
  directory. Put one in each root; `--scan` finds them.

Detailed configuration reference: `references/vercel-git-config.md`.

---

Part of [Paneltir](https://paneltir.dfklabs.com) by
[dfklabs](https://dfklabs.com). Apache-2.0; the bundled config templates are
public domain (CC0) and need no attribution.
