# Vercel git configuration reference

Source: https://vercel.com/docs/project-configuration/git-configuration

## `git.deploymentEnabled`

**Type:** an object mapping branch patterns to booleans, or a single boolean.
**Default:** `true` — meaning **every unspecified branch deploys**.

This default is the reason naive configs fail. Listing branches to disable them
leaves every unlisted and future branch enabled.

### Pattern matching

Branch keys accept [minimatch](https://github.com/isaacs/minimatch) syntax:

```json
{ "git": { "deploymentEnabled": { "internal-*": false } } }
```

### Precedence

When a branch matches multiple rules and **at least one is `true`, the
deployment happens**. There is no "most specific wins" — `true` wins.

```json
{ "git": { "deploymentEnabled": { "experiment-*": false, "*-dev": true } } }
```

A branch named `experiment-my-branch-dev` **does** deploy, because `*-dev`
matched as `true`.

This is what makes the wildcard-deny pattern work:

```json
{ "git": { "deploymentEnabled": { "*": false, "main": true } } }
```

`main` matches `*` (false) and `main` (true) → one `true` → deploys.
`feature/x` matches only `*` → no `true` → does not deploy.

It is also what makes a leftover `true` rule silently defeat the config. When a
branch still deploys after applying this, look for another rule matching it that
is set to `true`.

### Turning off everything

Set the property itself to `false` rather than using a map:

```json
{ "git": { "deploymentEnabled": false } }
```

Automatic deployments stop entirely; `vercel --prod` still works.

## Related options

### `github.autoJobCancelation`

**Type:** boolean. When `false`, Vercel builds pushes in sequence instead of
cancelling an in-flight build when a newer commit arrives.

Leave this at its default (`true`). Setting it to `false` **increases** quota
consumption, since superseded builds run to completion instead of being
cancelled.

### `github.autoAlias` (legacy)

When `false`, Vercel creates preview deployments on merge. Vercel's docs
recommend the staged production build / promote workflow instead.

### `github.enabled` (deprecated)

Superseded by `git.deploymentEnabled`. Do not use in new configs.

### `github.silent` (deprecated)

Superseded by the comment settings in the project's dashboard Git section.

## What `vercel.json` cannot express

**"Preview deployments only on pull requests."** This has no `vercel.json`
equivalent. It is a dashboard setting under the project's **Settings → Git**.
A `"*": false` rule blocks PR previews along with everything else, because
previews are triggered by branch pushes.

If the user needs PR previews, the dashboard is the only option, and
`deploymentEnabled` should be left alone.

## Timing

Vercel reads `vercel.json` from the pushed commit and decides whether to build
**before** starting a build. A blocked branch consumes no build minutes and no
deployment from the quota.

The config only takes effect once it is committed and pushed to the branch being
evaluated — most importantly, the production branch.

## Alternative surface: `vercel.ts`

Vercel also supports programmatic configuration:

```typescript
import type { VercelConfig } from '@vercel/config/v1';

export const config: VercelConfig = {
  git: {
    deploymentEnabled: {
      '*': false,
      main: true,
    },
  },
};
```

Semantics are identical. Prefer `vercel.json` unless the project already uses
`vercel.ts`, since the JSON form is what most tooling and documentation expects.
