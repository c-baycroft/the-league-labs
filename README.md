# The League Labs

Real photographs as game levels. Two playable browser games on real library bookshelves.

```bash
npm install
npm run dev      # then open the printed URL (use --host to test on your phone)
```

- **Piano Tiles** (`#piano`): each annotated book spine is a key. Tap the glowing book before it fades; the tempo climbs until you miss. Left-to-right books = low-to-high pentatonic notes. Timing runs on the Web Audio clock; hits are judged in the pointer event, not the animation frame.
- **Flappy Bird** (`#flappy`): fixed 60 Hz physics in photo-pixel space, sub-stepped collision (no tunnelling) against annotated solids. The camera scrolls with the bird. Score = book spines passed; reach the green goal to win.

## Controls
- **9:16** button: recording layout (portrait stage, HUD fades during play).
- **Annotate**: drag rectangles over the photo (tools: book / solid / nav / start / goal). **Save** keeps it in this browser; **Copy JSON** gives you normalized regions to paste into `games/*/config.json`.
- Space / Enter / tap restarts instantly.

## Layout
`shared/` (geometry + View letterbox/camera mapping, image loading, input + annotator), `games/*` (independent), `locations/library/` (photos), `src/main.ts` (home + router).
All geometry is normalized 0..1 of the photo, mapped through `View` so taps always hit the real pixels.
