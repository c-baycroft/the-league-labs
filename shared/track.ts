// 2D translation tracker: where is the current camera frame relative to the locked reference frame?
// Coarse-to-fine block matching on brightness-normalized pyramids with sub-pixel refinement.
// Small (~2–4 ms per frame) and robust to auto-exposure changes.
import type { Px } from './detect';

interface Level { g: Float32Array; w: number; h: number }

function gray(p: Px): Level {
  const { width: w, height: h, data } = p, g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  return { g, w, h };
}
function half(l: Level): Level {
  const w = l.w >> 1, h = l.h >> 1, g = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = 2 * y * l.w + 2 * x;
    g[y * w + x] = (l.g[i] + l.g[i + 1] + l.g[i + l.w] + l.g[i + l.w + 1]) / 4;
  }
  return { g, w, h };
}
function normalize(l: Level): Level {
  let m = 0; for (const v of l.g) m += v; m /= l.g.length;
  let s = 0; for (const v of l.g) s += (v - m) ** 2; s = Math.sqrt(s / l.g.length) || 1;
  const g = new Float32Array(l.g.length); for (let i = 0; i < g.length; i++) g[i] = (l.g[i] - m) / s;
  return { g, w: l.w, h: l.h };
}
function pyramid(p: Px) {
  const l0 = gray(p), l1 = half(l0), l2 = half(l1);
  return [normalize(l0), normalize(l1), normalize(l2)];
}

/** mean |ref(x+dx, y+dy) - cur(x, y)| over the overlap; Infinity if overlap is too small */
function sad(ref: Level, cur: Level, dx: number, dy: number, step: number) {
  const x0 = Math.max(0, -dx), x1 = Math.min(cur.w, ref.w - dx), y0 = Math.max(0, -dy), y1 = Math.min(cur.h, ref.h - dy);
  if ((x1 - x0) * (y1 - y0) < cur.w * cur.h * 0.35) return Infinity;
  let s = 0, n = 0;
  for (let y = y0; y < y1; y += step) {
    const ro = (y + dy) * ref.w + dx, co = y * cur.w;
    for (let x = x0; x < x1; x += step) { s += Math.abs(ref.g[ro + x] - cur.g[co + x]); n++; }
  }
  return s / n;
}
function search(ref: Level, cur: Level, cx: number, cy: number, r: number, step: number) {
  let best = Infinity, bx = cx, by = cy;
  for (let dy = cy - r; dy <= cy + r; dy++) for (let dx = cx - r; dx <= cx + r; dx++) {
    const v = sad(ref, cur, dx, dy, step);
    if (v < best) { best = v; bx = dx; by = dy; }
  }
  return { x: bx, y: by, err: best };
}

export class Tracker {
  /** offset in level-0 pixels: current frame pixel (x,y) shows reference pixel (x+dx, y+dy) */
  dx = 0; dy = 0; err = 0; ok = true;
  private ref: Level[];
  private maxErr: number;
  constructor(reference: Px, maxErr = 0.42) { this.ref = pyramid(reference); this.maxErr = maxErr; }

  update(frame: Px) {
    const cur = pyramid(frame);
    if (cur[0].w !== this.ref[0].w || cur[0].h !== this.ref[0].h) { this.ok = false; return false; }
    // coarse level: search around the prediction, widen if we lost it
    let c = search(this.ref[2], cur[2], Math.round(this.dx / 4), Math.round(this.dy / 4), this.ok ? 6 : 14, 1);
    c = search(this.ref[1], cur[1], c.x * 2, c.y * 2, 2, 1);
    const f = search(this.ref[0], cur[0], c.x * 2, c.y * 2, 2, 2);
    // sub-pixel: parabola through neighbours
    const sub = (a: number, b: number, m: number) => { const d = a - 2 * m + b; return d > 1e-6 ? Math.max(-0.5, Math.min(0.5, (a - b) / (2 * d))) : 0; };
    const sx = sub(sad(this.ref[0], cur[0], f.x - 1, f.y, 2), sad(this.ref[0], cur[0], f.x + 1, f.y, 2), f.err);
    const sy = sub(sad(this.ref[0], cur[0], f.x, f.y - 1, 2), sad(this.ref[0], cur[0], f.x, f.y + 1, 2), f.err);
    this.err = f.err;
    this.ok = f.err < this.maxErr;
    if (this.ok) { this.dx = f.x + (isFinite(sx) ? sx : 0); this.dy = f.y + (isFinite(sy) ? sy : 0); }
    return this.ok;
  }
}
