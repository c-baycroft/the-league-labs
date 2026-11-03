# The League Labs

Real photographs as game levels. Two playable browser games on real library bookshelves.

```bash
npm install
npm run dev      # then open the printed URL (use --host to test on your phone)
```

- **Piano Tiles** (`#piano`): each annotated book spine is a key. Tap the glowing book before it fades; the tempo climbs until you miss. Left-to-right books = low-to-high pentatonic notes. Timing runs on the Web Audio clock; hits are judged in the pointer event, not the animation frame.
- **Flappy Bird** (`#flappy`): fixed 60 Hz physics in photo-pixel space, sub-stepped collision (no tunnelling) against annotated solids. The camera scrolls with the bird. Score = book spines passed; reach the green goal to win.

## Scan a bookshelf (phone)
```bash
npm run dev          # https + LAN: open the printed "Network" https:// URL on your phone, accept the self-signed cert warning
```
Home -> **Scan a bookshelf**. Pick Piano Tiles or Flappy Bird, point at a shelf, pinch (or slide) to zoom. When the detector sees a stable result for ~1 s it freezes the frame and the game starts on that snapshot.
- Piano: the 10 book spines nearest the centre of your zoomed view become keys.
- Flappy: needs an open gap between a shelf board above and the book tops below. If there isn't one it says so and won't start (it never invents openings). The bird is sized from the book width.
- **Play now** forces a start; **Upload photo** works without a camera (or on desktop); **Rescan** returns to the camera; **Annotate** fixes any box the detector got wrong.
- Phone cameras require HTTPS. `npm run dev:local` is plain http for desktop-only testing. For a permanent link, `npm run build` and host `dist/` on any HTTPS static host (Netlify, Vercel, GitHub Pages).
- Detection is plain edge analysis (shared/detect.ts): works best on straight-on, evenly lit shelves; the game plays on a frozen snapshot, not tracked live video.

## Controls
- **9:16** button: recording layout (portrait stage, HUD fades during play).
- **Annotate**: drag rectangles over the photo (tools: book / solid / nav / start / goal). **Save** keeps it in this browser; **Copy JSON** gives you normalized regions to paste into `games/*/config.json`.
- Space / Enter / tap restarts instantly.

## Layout
`shared/` (geometry + View letterbox/camera mapping, image loading, input + annotator), `games/*` (independent), `locations/library/` (photos), `src/main.ts` (home + router).
All geometry is normalized 0..1 of the photo, mapped through `View` so taps always hit the real pixels.
