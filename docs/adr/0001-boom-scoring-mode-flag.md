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

`BOOM_SCORING` is parsed in `loadConfig` into `Config.boomScoring`, following the
existing pattern for every other setting. It accepts `random` (default) and
`legacy`; any other value throws at startup rather than falling back, because a
typo that silently selects the wrong game is worse than a failed boot.

Changing the flag requires a restart. That is accepted: it makes single-mode
operation structural rather than a property reviewers must keep verifying.

### Data model

`StoreData` gains `scoring: Record<string, 'random' | 'legacy'>`. The write path
stamps the date, not the constructor: `addEntry` stamps `random` and
`addPlacement` stamps `legacy`, each only if the date is not already stamped.

The `Store` therefore takes no mode argument. Which orchestration is installed
already decides which write path runs, so the mode of a date is a fact about how
it was recorded rather than a setting that has to be threaded through. A read
never stamps: `ensureDay` is untouched.

`Store.scoringFor(date)` resolves in this order:

1. `data.scoring[date]` when present.
2. `random` when `data.random_scoring_from` is set and `date >= random_scoring_from`,
   which covers stores already written by the current PR build.
3. `legacy`.

`isRandomEra(date)` becomes `scoringFor(date) === 'random'`. `scoreFor(date, game)`
already dispatches on it and needs no change: a random date scores its settled
awards, a legacy date scores `PODIUM_WEIGHTS` over `computePodium`.

`random_scoring_from` is retained for reading only. The constructor stops writing
it and the deploy-day cutover logic it carried is deleted, because the per-date
stamp makes that question moot: a date is stamped by whichever orchestration first
records a play on it.

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

Four existing tests in `tests/store.test.ts` assert the constructor cutover this
ADR deletes. Two of them (`starts random scoring on the deploy day itself`,
`picks up entries already recorded when it boots mid-window`) assert
`isRandomEra` before anything has been written, which the write-path stamp makes
meaningless; they are rewritten to assert the stamp after a write. The third
(`defers the cutover to tomorrow when the deploy day has already been announced`)
tests behaviour that no longer exists and is deleted, its guarantee absorbed by
the flip test above. The fourth (`keeps legacy 3-2-1 scoring for dates before the
random-scoring cutover`) passes unchanged, because `addPlacement` stamps
`legacy`.

## Consequences

- Two orchestrations to maintain. A bug in the Slack plumbing must be fixed twice
  unless it lives in `rules.ts`, `store.ts` or `leaderboard.ts`.
- The legacy orchestration is frozen. It exists to be identical to master, so it
  receives no improvements from the random path.
- `legacy/index.ts` is exempt from the project's complexity, method-length and
  nesting ceilings, and its lint scope says so. It is master's file verbatim, and
  its equivalence is asserted two ways: `diff` against `origin/master` showing only
  the four adjustments above, and master's own test suite passing unmodified.
  Refactoring it to satisfy a ceiling would break both proofs and defeat the
  rollback guarantee this ADR exists to provide. It stays frozen until the flag is
  removed, at which point the file is deleted rather than cleaned up.

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
