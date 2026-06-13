# Kill Switch — 3D Control Room (build spec / handoff)

Experimental landing-page flourish: a 3D "control room" where robot agents watch monitors
showing **live, interactive, indexable** Agent Guard dashboards, react to the cursor, and have
little personalities. Status: **POC works** (`site/public/lab/control-room.html`).

## Why it's safe for SEO
HTML-in-Canvas (Chrome's `drawElement` / `texElement2D`, origin trial, I/O 2026, est. stable
late-2026) keeps the source DOM in the page — "web crawlers and AI agents can index the text
rendered into your 2D/3D scenes," exposed to the a11y tree, find-in-page works. So live DOM on a
3D monitor stays **fully indexable**. Caveats: Chrome-only origin trial (needs token), cross-origin
blocked, main-thread scrolling. ⇒ must ship behind feature-detect with a fallback.

## POC (done) — `site/public/lab/control-room.html`
Three.js (ESM via CDN import map, r0.160). One monitor (bezel + stand + cyan glow) showing the
plan-limit gauges as a **procedural CanvasTexture**; one low-poly robot (capsule body, sphere head,
dark visor, two cyan eyes, blinking antenna) that idles/bobs, head-tracks the cursor, and glances at
the monitor every few seconds; whole scene parallax-tilts toward the pointer. WebGL fallback message.
Brand palette: navy #0a0e1f, cyan #5ce2e7, ember #ff9d42.

## Roadmap
1. **Live dashboard (HTML-in-Canvas).** Replace the painted texture with the real Agent Guard gauges
   DOM (reuse the `.ag-*` gauge markup/CSS from the landing) drawn onto the screen via `texElement2D`.
   Feature-detect; fall back to the canvas-texture (or a CSS-3D `<div>` overlaid on the screen quad).
2. **Interactivity.** Hover/click the dashboard; the status bar reacts; maybe drag a monitor.
3. **Robots with personality.** 2–3 robots; idle behaviors, occasional wandering paths, cursor-follow,
   monitor-glance, reactions when the user interacts. Consider a tiny state machine per robot.
4. **More monitors** = control-room feel: a spend sparkline, a red "🛑 BLOCKED — the $4,200 weekend"
   alert screen, the `agent-guard usage` terminal.
5. **Integrate + fallback.** Drop into the landing (hero backdrop or own section) with a static / CSS-3D
   fallback so non-Chrome + crawlers stay first-class. Lazy-load Three.js; respect prefers-reduced-motion.

## Notes for whoever continues
- 3D is visual/iterative — preview at `http://localhost:8788/lab/control-room.html` (run
  `cd site && wrangler dev --port 8788 --local`) and screenshot to tune. The site preview server +
  the guard proxy (:8787) may already be running from a prior session.
- The landing's Agent Guard section is already redesigned (after the hero): animated macOS terminal
  with the status bar, full-width npx copy bar, the gauge visual. Reuse those `.ag-*` styles.
- Heavy 3D iteration is token-expensive — best done in focused sessions with a fresh context.
