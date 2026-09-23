# ADR 0003: Medals go to the middle three posts, by position

Date: 2026-09-23
Status: Accepted. Supersedes the medal selection in ADR 0002; its bonus-entry draw is unchanged.

## Context

ADR 0002 gave a bonus entry to the first, last and middle-by-time posters. Players started
automating their first post to win that bonus. The prod store showed the pattern already existed
before medals and medals gave it a payoff:

| Measure (prod store, 577 games up to 2026-09-23) | Value |
|---|---|
| Games whose first post landed under 1s after 12:00 | 424 |
| Median first-post offset | 0.40s |
| Games where one player posted first | 308 |

Any medal tied to a known instant can be automated. First is 12:00:00, last is 12:09:59. "Second
place" is the same race with one bot in front.

## Decision

The three posts in the middle of the posting order get the medal:

- Odd player count: the exact centre three.
- Even player count: the centre two, plus the post just before or just after them, chosen by the
  draw's random source. With 6 players that is posts 2-4 or 3-5.
- Three or fewer players: everyone.

## Consequences

- No posting time secures a medal, because the player count is unknown until the window shuts.
- First and last never get a medal once five or more play, so racing or sniping earns nothing.
- A medal becomes a reward for landing in the pack, not for reflexes.
- Awards settled under ADR 0002 keep their stored `first`/`last` labels; new awards store
  `middle`.

## Alternatives rejected

- **Second, middle, last.** Second still rewards speed, and last is a known instant.
- **Middle by time.** Hard to automate alone, but two players at each end can move the halfway
  mark. Position cannot be moved that way.
