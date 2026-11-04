# The League Labs

Real photographs as game levels. Two playable browser games on real library bookshelves.

```bash
npm install
npm run dev      # then open the printed URL (use --host to test on your phone)
```

- **Piano Tiles** (`#piano`): each annotated book spine is a key. Tap the glowing book before it fades; the tempo climbs until you miss. Left-to-right books = low-to-high pentatonic notes. Timing runs on the Web Audio clock; hits are judged in the pointer event, not the animation frame.
- **Flappy Bird** (`#flappy`): fixed 60 Hz physics in photo-pixel space, sub-stepped collision (no tunnelling) against annotated solids. The camera scrolls with the bird. Score = book spines passed; reach the green goal to win.

## Scan a bookshelf (phone)
Install: open **https://c-baycroft.github.io/the-league-labs/** on your phone -> Add to Home Screen.

1. **Point at the whole shelf.** It finds the shelf and locks automatically once you're steady (or tap *Lock shelf*).
2. **Pinch to zoom in.** The camera stays live; detected books stay glued to the real ones (motion tracking).
   Piano starts when 5–12 books fill the screen; Flappy when you've zoomed in on the gap above the books.
3. **Play on the live camera.** Hand shake is stabilised; if the camera loses the shelf the game pauses instead of guessing.
   Restarts reuse the lock — *Rescan* only when you move to a new shelf.

How it works (all on-device, no ML, ~2 ms/frame):
- `shared/detect.ts` — shelf boards from long horizontal edges; spine boundaries from column colour changes, dark seams and long vertical edges averaged over the shelf height (so spine text doesn't split books); book tops from colour change below the board.
- `shared/track.ts` — coarse-to-fine block matching against the locked frame (sub-pixel, exposure-normalised).
- `shared/scene.ts` — games run in the locked frame's coordinates; the live video is drawn at the tracked offset, so geometry and video stay aligned.
- Zoom is digital (a crop of the camera frame), so the zoom level is known exactly.
- Flappy only plays where there is a real gap between book tops and the board above; otherwise it says so.

Limits: tracking handles shake, small pans and small tilts — not walking closer/further or big rotations (it pauses; rescan).
Dev: `npm run dev` (https, LAN) or `npm run dev:local`. Test without a camera: `#scan?photo=library/piano-bookshelf.jpg&shake=1` simulates a handheld camera.

## Controls
- **9:16** button: recording layout (portrait stage, HUD fades during play).
- **Annotate**: drag rectangles over the photo (tools: book / solid / nav / start / goal). **Save** keeps it in this browser; **Copy JSON** gives you normalized regions to paste into `games/*/config.json`.
- Space / Enter / tap restarts instantly.

## Layout
`shared/` (geometry + View letterbox/camera mapping, image loading, input + annotator), `games/*` (independent), `locations/library/` (photos), `src/main.ts` (home + router).
All geometry is normalized 0..1 of the photo, mapped through `View` so taps always hit the real pixels.
