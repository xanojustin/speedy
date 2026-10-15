# Speedy performance (U13)

Machine: Apple Silicon, macOS 26.6.2. Build: `bun run tauri build` (release, LTO, ad-hoc signed), app bundle 8.0 MB.

## Measured by the agent (2026-10-14)

### Cold launch to window: PASS (target under 1 s)

The app was launched with `open -n Speedy.app` (a LaunchServices launch, as from Finder or the Dock). Timing ran until the main window appeared on screen, polled from the CoreGraphics window list:

| Run | Launch to window |
|---|---|
| 1 (first launch after build) | 697 ms |
| 2 | 295 ms |
| 3 | 292 ms |

This measures when the window appears, not when the sidebar is interactive. The webview's own first paint is part of that window time. The sidebar becomes interactive after `state_load`, a single small JSON read, so the gap should be small. Confirm it by eye.

### Memory at idle (no threads open)

These are Speedy's own processes only: the Rust core plus the WebKit processes it spawned.

| Process | phys_footprint | RSS |
|---|---|---|
| speedy (Rust core) | 28 MB | 101 MB |
| com.apple.WebKit.WebContent | 46 MB | 59 MB |
| com.apple.WebKit.GPU | 13 MB | 35 MB |
| com.apple.WebKit.Networking | 6 MB | 16 MB |
| **Total** | **≈93 MB** | **≈211 MB** |

RSS counts shared framework pages once per process, so phys_footprint is the fairer comparison.

## Needs a human run (Success Criteria)

The plan's measurement state has 5 threads, each with one completed turn and a live shell. Reaching it needs real agent turns, which the agent can't run safely or cheaply. Run it and fill this in:

| Metric | Speedy | VS Code + extension (5 Claude tabs, 5 terminals) | Target |
|---|---|---|---|
| Cold launch to interactive | | | Speedy faster, and under 1 s |
| Own processes, phys_footprint (Speedy: core + WebKit; VS Code: main, renderer, GPU, extension host) | | | Speedy lower, and under 400 MB |
| Including `claude` and shell children (reference only) | | | none |
| `cat` of a 50 MB file while two other threads stream | no dropped keys, hitches under 100 ms? | | |

How to measure:

```sh
# Speedy's own processes
P=$(pgrep -f "Speedy.app/Contents/MacOS/speedy")
footprint $P | grep phys_footprint
# WebKit processes spawned by Speedy (compare the list before and after launch)
ps -A -o pid,rss,comm | grep -E 'WebKit\.(WebContent|GPU|Networking)'
# VS Code
ps -A -o pid,rss,comm | grep -E 'Code Helper|Electron|Visual Studio Code'
```

Record any misses here with their causes (see the Tauri/WKWebView memory risk in the plan).
