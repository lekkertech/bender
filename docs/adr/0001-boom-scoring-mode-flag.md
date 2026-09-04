# ADR 0001: Gate the boom scoring mechanism behind BOOM_SCORING

Date: 2026-09-04
Status: Accepted

## Context

PR #3 replaces the boom game's 3-2-1 podium with randomised point distribution: a
fixed 12:00-12:05 entry window, every unique entrant drawing a distinct value in
1..n when the window settles, and medals following point rank rather than arrival
order. The mechanic is experimental and may be withdrawn after the team plays it.

The two mechanisms are not variations on a shared flow. They differ in when the
window closes, what closes it, what a late poster is told, when medals attach,
what triggers the daily announcement, and how a day contributes to the weekly
leaderboard. `src/features/boom/index.ts` is 389 lines on master and 459 lines on
the PR branch, and the overlap between them is the Slack plumbing, not the game.

Rolling back by reverting the merge is not acceptable: the store written under the
random mechanic must keep its recorded results, and a revert would strand the
`awards` it wrote.

## Decision

Select the mechanism once, at feature registration, from a `BOOM_SCORING`
environment variable. Install exactly one orchestration. Never run a branch that
mixes them.

### Module layout

| Path | Responsibility |
|---|---|
| `src/features/boom/index.ts` | Reads `BOOM_SCORING`, constructs the `Store`, delegates to one orchestration. |
| `src/features/boom/legacy/index.ts` | The 3-2-1 podium mechanism as it exists on master. |
| `src/features/boom/random/index.ts` | The randomised mechanism as it exists on PR #3. |
| `src/features/boom/leaderboard.ts` | The `app_mention` leaderboard handler, shared, parameterised by the mode's catch-up function. |
| `src/features/boom/rules.ts` | Pure date, emoji and window helpers for both modes. |
| `src/features/boom/store.ts` | Persistence for both modes, plus the per-date mode stamp. |

`BOOM_SCORING` accepts `random` (default) and `legacy`. Any other value is a
startup error rather than a silent fallback, because a typo that silently selects
the wrong game is worse than a failed boot.

Changing the flag requires a restart. That is accepted: it makes single-mode
operation structural rather than a property reviewers must keep verifying.

### Data model

`StoreData` gains `scoring: Record<string, 'random' | 'legacy'>`. `Store.ensureDay`
stamps a date the first time it is written, from the mode the `Store` was
constructed with. The `Store` constructor takes that mode as an argument rather
than reading the environment itself, so tests can drive both without mutating
`process.env`.

`Store.scoringFor(date)` resolves in this order:

1. `data.scoring[date]` when present.
2. `random` when `data.random_scoring_from` is set and `date >= random_scoring_from`,
   which covers stores already written by the current PR build.
3. `legacy`.

`isRandomEra(date)` becomes `scoringFor(date) === 'random'`. `scoreFor(date, game)`
already dispatches on it and needs no change: a random date scores its settled
awards, a legacy date scores `PODIUM_WEIGHTS` over `computePodium`.

`random_scoring_from` is retained for reading only. The constructor stops writing
it and the cutover logic it carried is deleted, because the per-date stamp makes
the deploy-day question moot: the day a flagged build boots is stamped with
whatever mode it booted in, on that day's first entry.

### Behaviour contract

A date is wholly one mechanism. Its entry window, its clown rules, its medals, its
announcement text and its points all come from the orchestration named by its
stamp. Flipping the flag never alters a date already stamped.

A week spanning a flip sums each day under that day's own mechanism. This is
dispatch, not blending: no single day is ever part-random and part-legacy.

### Store methods to restore

PR #3 removed three methods the legacy orchestration calls. They return unchanged:
`getPodiumMessages`, `hasAnyPlacement`, `recordedDates`.

## Testing

The rollback guarantee is proved mechanically, not by inspection.

- `tests/boom.feature.test.ts` and `tests/boom.race.test.ts` as they exist on
  master run against the flagged build with `BOOM_SCORING=legacy` and must pass
  unmodified. Any edit to those files to make them pass invalidates the guarantee.
- PR #3's suite runs with `BOOM_SCORING=random`.
- A flip test: a Monday settled under `random`, the flag changed to `legacy`, a
  Wednesday played under legacy. Monday's `awards` are byte-identical afterwards
  and the week's totals sum both days under their own rules.
- A rejection test: an unrecognised `BOOM_SCORING` value fails registration.

## Consequences

- Two orchestrations to maintain. A bug in the Slack plumbing must be fixed twice
  unless it lives in `rules.ts`, `store.ts` or `leaderboard.ts`.
- The legacy orchestration is frozen. It exists to be identical to master, so it
  receives no improvements from the random path.
- `store.ts` stays above the 300-line ceiling. It is 414 lines on master and 679
  on the PR branch, so this change does not introduce the problem, and splitting
  it is deliberately left out of scope.

## Alternatives rejected

**Flag only the point assignment.** Swap `assignRandomPoints` for a 3-2-1
assigner and keep one orchestration. Roughly 60 lines instead of 400. Rejected
because rollback would not restore the current behaviour: the fixed 12:00-12:05
window, the settle-and-catch-up machinery and the changed clown rules would all
remain, so a 4th entrant inside the window would score zero rather than be clowned
on arrival.

**Per-date dispatch inside one handler set.** Load both orchestrations and route
each message by its date's stamp, letting a flip take effect without a restart.
Rejected because every shared code path becomes a conditional, which is the
bleeding between mechanisms this ADR exists to prevent.
