# ADR 0002: Timing medals give the first, last and middle to post a bonus entry

Date: 2026-09-21
Status: Accepted

## Context

Under random scoring (ADR 0001) the moment a player posts inside the 12:00-12:10 window has no
bearing on their score. The team wanted a little of the old race back without returning to a
podium decided by arrival order: a reward for being quick, for holding out to the end, and for
landing in the middle, that improves a player's chances rather than fixing their result.

## Decision

At settle time, each game's entrants are sorted by message `ts` and up to three **timing
medallists** are picked:

- **first**: the earliest entrant.
- **last**: the latest entrant.
- **middle**: take the exact halfway point between the first and last timestamps. The nearest
  entrant before it and the nearest after it are the candidates; first and last are discarded.
  None left: no middle medal. One: they get it. Two: the closer one, and an exact tie is settled
  by the same `rng` as the points draw.

One entrant therefore holds one medal, two hold first and last, three or more hold all three.

Each medallist is listed twice in the draw. `assignRandomPoints` gives every listing a distinct
draw, collapses a player listed twice to their better draw, and then scores the `n` distinct
players `n..1` by rank. A game's values are still exactly `1..n`; the medal lifts the odds of a
high rank and nothing else. A solo entrant scores 1.

The medallists are recorded on the awards as `medal: "first" | "last" | "middle"`. A `:medal:`
reaction goes on each medallist's message in the same pass that puts the podium medals on the top
three earners, sharing its `medalled[date][game]` retry. The daily results append `:medal:` after
a medallist's points. Both are displays of the stored label; the bot never reads reactions back.

### Choices made for the smallest change

- **Per game, not per day.** Each of `boom`, `hadeda` and `wednesday` picks its own medallists and
  feeds the bonus entry into its own draw, following the one-list-per-game structure that exists.
- **Decided at settle time, not on arrival.** "Last" and "middle" cannot be known before the window
  shuts, and a live "first" would be at the mercy of delivery order. Settling all three together
  reuses the existing timer, catch-up and medal retry paths and adds no new state beyond the label.
  The cost is that nobody sees a medal during the window.
- **A new emoji, and the podium medals stay.** `:first_place_medal:` and friends say who scored
  most and match the leaderboard headings; `:medal:` says who drew twice. Reusing one for the other
  would make the two meanings collide.
- **Bonus entries appended in post order.** Appending in medal order (first, last, middle) would
  change how a seeded draw consumes its `rng` and so which entrant a fixed sequence favours. Post
  order keeps the draw deterministic for a given `rng`. Every game with entrants now has at least
  one medallist, so a seeded draw consumes more `rng` calls than the previous build and its
  outcome differs for the same seed.
- **No configuration.** The emoji and the three medal kinds are constants. The legacy orchestration
  is frozen by ADR 0001 and does not call `resolveGame`, so it is unaffected.

## Consequences

- `Award` gains an optional `medal` field. Awards written before this change simply lack it and
  load unchanged; the field is never required.
- Days already settled are never re-scored. The rule applies from the first settle after deploy.
- The points ceiling and the "no gaps" guarantee are unchanged, so every existing test that pins
  exact point values still holds. The seeded-draw feature test depends on the post-order choice
  above.
- Timestamps are compared in integer microseconds, so an exact tie for the middle is detected
  exactly and settled on `rng`, not lost to floating-point rounding on ten-digit epoch seconds.

## Alternatives rejected

**Score the enlarged draw and let the values stand.** Give the `n + k` listings `n + k .. 1`,
then collapse duplicates keeping the higher value. A medallist could then score above the entrant
count and gaps would appear (a solo entrant would always score 2). Rejected in favour of ranking the
survivors, which keeps the score range a property of how many people played.

**Award the first medal live.** React to the first in-window post as it arrives. Rejected: a
late-delivered earlier message would already have been beaten, and the other two medals cannot be
live anyway, so it would add a second medal path for one of the three.
