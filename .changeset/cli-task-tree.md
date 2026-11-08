---
"@tenora/core": minor
"@tenora/cli": minor
"@tenora/multi-tenant": minor
---

Show progress in the terminal, and add `--step` to run migrations one at a time.

- In a terminal, `migrate`, `rollback`, `seed:run` and their tenant versions now show a live task tree: which migration is running, what finished and how long it took, what failed and why, what was rolled back with it and what never ran. Tenant commands also show a progress bar. The other commands get a one-line result.
- Output that is piped or redirected, or that runs in CI (`CI` is set) or with `TERM=dumb`, stays exactly as it was, so scripts keep working. `NO_COLOR` turns the colours off.
- No new dependencies.
- `tenora migrate --step`, also on `migrate:base` and `migrate:tenants`, gives every migration its own batch, so `tenora rollback` undoes them one at a time. If one fails, the ones before it stay applied.
