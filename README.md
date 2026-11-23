# site-generator-speed-01

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/iAm-182/site-generator-speed-01/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/iAm-182/site-generator-speed-01/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster drop-in for make.fun's own makefun-site 1.0.0 static site generator.
`solve.js` returns byte-for-byte the same output tree as makefun-site 1.0.0
for every case, and does it with much less CPU time: on the practice set
it passes all 3 cases identically and runs in about a third of the CPU
time of the house baseline measured beside it on the same machine.

How it gets there, in its own code written for this bounty:

- Templates are compiled once per build into plain JavaScript: loop
  bindings become locals, includes share one output array, and values are
  resolved through a frame chain that keeps the dialect's scoping rules
  (innermost loop first, then the page's values).
- Markdown is rendered in a single pass over its lines with no token
  objects, and inline markup is scanned with a native regex that skips
  plain text in chunks instead of walking every character.
- Slugs are cached per build, HTML escaping takes a fast path when nothing
  needs escaping, and the build reuses its per-render vars object instead
  of allocating one per page.

## Run it

```sh
node main.ts
```

`main.ts` reads every case from `/input/cases.json` (or
`$MAKEFUN_INPUT_DIR/cases.json` outside the sandbox) and writes
`/output/answers.json` (or `$MAKEFUN_OUTPUT_DIR/answers.json`). It needs
Node 22 or later and no dependencies.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
