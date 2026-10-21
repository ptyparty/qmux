# Phase 2 spike: can OpenTUI draw a multiplexer fast enough?

`grid-app.ts` is a 16-pane grid. Each pane is an OpenTUI `EmbeddedTerminalRenderable`, which runs Ghostty's VT emulator in native code, fed from a PTY. `measure.ts` runs either the grid app or zellij inside a PTY it owns and gives both the same panes:

- **Echo pane:** pane 0 runs `cat` and has focus.
- **Busy panes:** they cycle through `yes`, a loop that `cat`s a 4 MB truecolor file, and `htop`.

## How it measures

- **Latency:** the harness types a unique character and times how long it takes to appear in the multiplexer's output.
- **CPU and memory:** counted for the multiplexer's own processes only, not the programs in its panes.
- **Throughput:** the time to `cat` 38.6 MB in the focused pane.

Results are from Linux on 12 threads, with a 200×60 outer terminal, Bun 1.4.3, OpenTUI 0.6.6, and zellij 0.44.3. The machine had a load average of about 7 from other work, so compare rows with each other rather than reading them as absolute numbers.

```bash
bun spike/measure.ts --target qmux --busy 15 --fps 120
bun spike/measure.ts --target zellij --busy 15
bun spike/measure.ts --target qmux --throughput --busy 0
```

## Keystroke latency, 16 panes

| Scenario | Multiplexer | p50 | p95 | p99 | CPU | RSS |
|---|---|---|---|---|---|---|
| Idle | qmux | 1.1 ms | 2.2 | 4.3 | 2% | 69 MB |
| Idle | zellij | 11.7 ms | 12.8 | 13.8 | 8% | 96 MB |
| 15 busy | qmux, 60 fps | 10–13 ms | 19–24 | 24–28 | 41% | 83 MB |
| 15 busy | qmux, 120 fps | 8.6 ms | 15.0 | 18.4 | 42% | 83 MB |
| 15 busy | zellij | 27–34 ms | 43–78 | 48–143 | 130–145% | 205 MB |

## Throughput: `cat` 38.6 MB in the focused pane

| Other panes | qmux | zellij |
|---|---|---|
| Idle | 4.1 s | 2.7 s |
| 15 busy | 48 s | 35 s |

qmux limits PTY reading to 6 ms of every 16 ms window, so typing stays fast. That limit is why it trails zellij here, and it can be tuned.

## What it took to get there

1. **`Bun.Terminal` has no way to pause reading.** A pane running `yes` flooded the main thread with about 20 MB/s. Typing waited behind it (p50 169 ms), and frames took about 40 ms.
2. **Bun's `tty.ReadStream` uses a blocking thread per stream.** On a PTY master, each stream holds one pool thread in a blocking read. The pool has one thread per core, so the 13th pane stopped receiving output.
3. **`spike/pty.ts` replaces both.** It opens PTYs with `openpty` through `bun:ffi`. A worker thread `poll()`s every PTY master, and the main thread does non-blocking reads. A pane is re-armed only after its data is drained, so unread output stays in the kernel and blocks noisy programs. This is real backpressure.
4. **Reads are scheduled round-robin within a time budget.** The focused pane skips the queue. Without round-robin, the same busy panes took the whole budget every window and the echo pane starved (p50 320 ms).
5. **Children need a controlling terminal.** `Bun.spawn` gives them none, so they never get `SIGWINCH` when a pane resizes. The spike wraps commands in `setsid --ctty` (util-linux). macOS has no such command, so a native helper will be needed there.

## Verdict

The gate passes:

- **Latency:** it meets the ~10 ms target at the median, at 120 fps.
- **Compared with zellij:** under load it is 3× faster to show a keystroke, using about a third of the CPU and less than half the memory.
- **Throughput:** about 0.7× zellij's, at the current budget.

We do not need our own libghostty binding: OpenTUI's embedded terminal already runs the emulator in native code. The PTY and scheduling layer has to be our own.
