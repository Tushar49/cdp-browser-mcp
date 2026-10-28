#!/usr/bin/env node
// Promote dev → main, run locally. This replaces the retired
// .github/workflows/promote.yml: a workflow runner can only ever push as
// github-actions[bot], and main's ruleset (no merge commits + verified
// signatures) blocks that actor — the bypass list only covers the repo
// owner. Running here uses the laptop's credential manager, so the push
// actor is the owner and bypass applies.
//
// Usage:   node scripts/promote.mjs <version>     (e.g. v5.3.0)
// Preconditions: clean working tree (it checks), local `main` exists.
//
// Steps mirror the old workflow exactly:
//   fetch → merge origin/dev --no-ff --no-commit → sync .gitignore from
//   dev's .main.gitignore shadow (when dev changed it) → strip dev-only
//   paths → hard-verify the index → commit → push → restore your branch.
//
// AFTER the push: confirm Guard main is green before tagging. Never tag
// past a red guard (v5.1.0 precedent).
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const DEV_ONLY = [
  '_archive',
  '.research',
  '.githooks',
  '.main.gitignore',
  '.github/AGENTS.md',
  '.github/copilot-instructions.md',
];

const version = process.argv[2];
if (!version) {
  console.error('usage: node scripts/promote.mjs <version>   e.g. v5.3.0');
  process.exit(1);
}

const git = (args, opts = {}) => {
  const r = spawnSync('git', args, { encoding: 'utf8', ...opts });
  if (r.error || (r.status !== 0 && !(opts.allowFailure ?? false))) {
    console.error(`git ${args.join(' ')} failed:`);
    console.error((r.stderr || r.stdout || r.error?.message || '').trim());
    process.exit(1);
  }
  return r;
};
const out = (args, opts) => git(args, opts).stdout.trim();
const tryStep = (label, fn) => {
  console.log(`── ${label} ──`);
  try {
    fn();
  } catch (e) {
    console.error(`✗ ${label}: ${e.message}`);
    process.exit(1);
  }
};

if (out(['status', '--porcelain'])) {
  console.error('Working tree not clean — commit or stash first.');
  process.exit(1);
}
const prev = out(['branch', '--show-current']);

tryStep('fetch origin', () => git(['fetch', 'origin']));
tryStep('checkout main', () => git(['checkout', 'main']));
tryStep('update main', () => git(['pull', '--ff-only']));
tryStep('merge origin/dev (no commit)', () =>
  git(['merge', '--no-ff', '--no-commit', 'origin/dev'], { allowFailure: true }),
);

tryStep('sync .gitignore from dev shadow (when dev changed it)', () => {
  const staged = out(['ls-files', '.main.gitignore']);
  if (!staged) {
    console.log('No .main.gitignore in the merge — keeping main\'s .gitignore.');
    return;
  }
  const unchanged = spawnSync('git', ['diff', '--cached', '--quiet', '--', '.main.gitignore']).status === 0;
  if (unchanged) {
    console.log('Dev did not change .main.gitignore — keeping main\'s .gitignore.');
    return;
  }
  writeFileSync('.gitignore', out(['show', ':.main.gitignore']) + '\n');
  git(['add', '.gitignore']);
  console.log('Synced .gitignore from .main.gitignore.');
});

tryStep('strip dev-only paths', () =>
  git(['rm', '-rf', '-q', '--ignore-unmatch', ...DEV_ONLY]),
);

tryStep('hard-verify the index', () => {
  const leaks = out(['ls-files', ...DEV_ONLY]);
  if (leaks) {
    console.error('✗ dev-only paths survived the strip:\n' + leaks);
    process.exit(1);
  }
  const unmerged = out(['diff', '--name-only', '--diff-filter=U']);
  if (unmerged) {
    console.error('✗ unmergeable paths outside the strip list:\n' + unmerged);
    process.exit(1);
  }
  const strays = out(['status', '--short'])
    .split('\n')
    .filter((l) => DEV_ONLY.some((p) => l.includes(p)));
  if (strays.length) {
    console.error('✗ working tree still holds dev-only paths:\n' + strays.join('\n'));
    process.exit(1);
  }
  console.log('✓ no dev-only paths anywhere.');
});

tryStep('commit', () => git(['commit', '-m', `Merge dev → main: ${version}`]));
tryStep('push origin main', () => git(['push', 'origin', 'main']));
if (prev && prev !== 'main') tryStep(`restore ${prev}`, () => git(['checkout', prev]));

console.log(`\n✅ Promoted: main is now "Merge dev → main: ${version}"`);
console.log('NEXT: wait for Guard main + CI to go green, THEN tag.');
console.log('Never tag past a red Guard main (v5.1.0 precedent).');
