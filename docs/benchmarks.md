# Benchmarks

## Matching engine throughput (task 2.9)

`node scripts/benchEngine.js` replays 1,000,000 pre-generated commands through `applyCommand` on one thread. The first pass has no timer per command and gives the throughput. The second pass puts a timer around every command and gives the latencies. Both passes must end in the same book hash or the script fails.

Add `--deep` to never end the session, so the book keeps growing. Add a number to change the command count.

Hardware: Intel Core i7-13650HX (20 threads), 16 GB RAM, Windows 11, Node v24.12.0.

### Baseline, 2026-11-06

| Run | Resting orders at the end | Commands/s | p50 | p99 | p99.9 |
|---|---|---|---|---|---|
| default, run 1 | 9 | 2,345,898 | 300 ns | 2,100 ns | 7,500 ns |
| default, run 2 | 9 | 2,310,478 | 300 ns | 2,200 ns | 7,500 ns |
| default, run 3 | 9 | 2,360,252 | 300 ns | 2,100 ns | 7,400 ns |
| `--deep`, run 1 | 5,706 | 1,979,024 | 300 ns | 2,800 ns | 8,200 ns |
| `--deep`, run 2 | 5,706 | 2,026,677 | 300 ns | 2,800 ns | 7,800 ns |
| `--deep`, run 3 | 5,706 | 1,851,892 | 400 ns | 2,900 ns | 7,900 ns |

Target was above 100,000 commands per second. The engine is about 20 times over it.

### What these numbers are and are not

- They measure the engine only: in-process calls with plain objects, no database, no network, no event log. In the full system each command also pays for a Postgres transaction, so end-to-end throughput will be far lower. Task 8.1 measures that.
- The stream is synthetic: 50% limit orders, 15% market, 15% cancel, 15% replace, a few percent IOC and FOK, a few bad orders. About 2.6 million events come out of 1 million commands.
- In the default stream a rare end-of-session command keeps the book shallow (about 9 orders at the end). `--deep` removes it, and the book grows to about 5,700 resting orders. Cancel is O(1) and a new price level costs a binary search plus an array splice, so depth costs a little, which is what the deep runs show. A far deeper book than this has not been measured.
- p99.9 and max are the spread of garbage collection and the OS, not of the algorithm.
- One machine, one Node version. Run it again on the machine you quote numbers from.
