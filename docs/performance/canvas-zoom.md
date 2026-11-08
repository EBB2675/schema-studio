# Canvas zoom measurements — issue #161

Measured on 8 November 2026, comparing `develop` at `14a8f07` with
`smooth-canvas-zoom`. The change removes React state updates from viewport
synchronization: only the HTML layer transforms and an open quantity form's
position change on each animation frame. Card dragging reads the current
Cytoscape zoom directly. Mounting a layer or moving a form's anchor synchronizes
its position before paint.

## Method

- Production Vite Pages builds; Cytoscape 3.33.1, React 19.
- Local headless Chromium 153.0.8010.12, 1440 × 900 viewport, device scale 1.
- Real BAM v0 profile from the existing isolated environment, source commit
  `4162906a1bc634b078ccd48c9cd72f4ccd2dc0af`: 364 canvas nodes and 103 edges.
  This snapshot is larger than the issue's 352-class example.
- Whole data model in UML mode. This view intentionally disables editing;
  edit-layer behavior is covered by regression tests instead.
- Three 180-frame sweeps per configuration, varying zoom between 0.05 and 1.0
  around the viewport center. Simulated wheel events activate Cytoscape's
  wheel-rendering path; an explicit zoom value makes the sweep independent of
  wheel-device normalization. This does not measure physical input latency.
- Compare the last two runs to reduce cold-cache/JIT effects. Other builds and
  tests were stopped during these comparison runs.

## First iteration: React updates

Warm runs, times in milliseconds:

| Measurement | Before (two runs) | After (two runs) |
| --- | --- | --- |
| JavaScript execution | 138, 130 | 57, 62 |
| Total main-thread task time | 813, 826 | 706, 771 |
| Median frame interval | 16.7, 16.7 | 16.7, 16.7 |
| 95th percentile frame interval | 33.3, 33.3 | 33.4, 33.4 |

JavaScript execution fell by about 56%, and main-thread task time by about 10%.
There is no demonstrated improvement in frame pacing in this environment.
Headless results are noisy and do not establish GPU/display performance on
users' machines. A visible-browser mouse and trackpad check remains useful.

Trials with `textureOnViewport`, `hideEdgesOnViewport`, and a six-pixel minimum
label size did not show a convincing frame-time advantage. They are not enabled
by this change. These first-iteration measurements retained the original wheel handler.

## Repeating the measurement

Launch a local Chromium with `--remote-debugging-port=9333` and a separate
`--user-data-dir`, serve a production build, and open the diagram to measure.
Keep only that app tab open. With Node 22 or newer, run from `web/`:

```sh
node scripts/benchmark-canvas.mjs http://127.0.0.1:9333
```

The script prints three JSON records and restores the original pan and zoom.
It uses Chromium's debugging protocol and Cytoscape's private container
registration for diagnostics only; no benchmark code ships in the app.

Regression tests verify zero React commits during pan in UML and edit mode,
including an open quantity form; overlay alignment after zoom and mode changes;
and dragging at the current zoom before the next animation frame. A real
Chromium wheel event was also checked against the overlay transform.


## Second iteration: consistent mouse-wheel response

After the first local trial, Esma reported both slow zoom and stuttering, mostly
with a mouse wheel. `utils/wheelZoom.ts` now handles wheel input before
Cytoscape's device-detection handler. It normalizes pixel/line/page units, caps
individual event deltas, accumulates a bounded zoom target, and approaches that
target over a short animation. The time constant is 20 ms (roughly 100–140 ms
to settle a typical isolated notch), with no device-detection warmup.

The cursor remains anchored. Reverse scrolling immediately discards the old
direction's target; dragging, fit/focus actions, and disabled zoom cancel the
animation. Reduced-motion users get the target on the next frame without easing.
Native touch gestures remain with Cytoscape. This is a change to wheel response,
not evidence of faster rendering or lower physical input latency.

Actual Chromium CDP `Input.dispatchMouseEvent` wheel input on the same whole
model, six pixel-mode events of `deltaY=-100`, 220 ms apart, starting at zoom 0.1:

| Result | Original | Revised |
| --- | --- | --- |
| Zoom multiplier, events 1–4 | 1.0328 each | 1.6487 each |
| Zoom multiplier, events 5–6 | 1.0195 each | 1.6487 each |
| Total zoom updates across six events | 6 | 47 |

These numbers are specific to pixel-mode wheel events in Chromium. Other
browsers can report line units and had different original multipliers. The
new unit tests also exercise line/page input, small trackpad deltas, cursor
anchoring, bounds, reversal, cancellation, cleanup and reduced motion using real
Cytoscape viewport math.

The camera-sweep benchmark above still measures controlled camera work; it
explicitly sets zoom and cannot assess the new wheel easing. Use actual wheel
input and a normal-browser trial to judge that behavior. The local optimized
preview at port 4176 has been rebuilt with this second iteration.
