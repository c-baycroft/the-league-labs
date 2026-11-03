// Lightweight shelf analysis (plain 2D pixel math, no ML). Finds shelf boards from long horizontal
// edges and book spines from vertical edges, then builds game regions in normalized coordinates.
import { Region } from './geometry';

interface Seg { x0: number; x1: number; top: number }
interface Analysis { w: number; h: number; ceilY: number | null; floorY: number | null; bt: number; bb: number; segs: Seg[] }

export interface PianoResult { ok: boolean; msg: string; regions: Region[] }
export interface FlappyResult { ok: boolean; msg: string; regions: Region[]; scale: number }

const EDGE_T = 20;

function analyze(src: CanvasImageSource, sw: number, sh: number): Analysis {
  const w = Math.min(480, Math.round(sw)), h = Math.max(8, Math.round(w * sh / sw));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const cx = c.getContext('2d', { willReadFrequently: true })!;
  cx.drawImage(src, 0, 0, sw, sh, 0, 0, w, h);
  const d = cx.getImageData(0, 0, w, h).data;
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];

  // shelf boards = rows where a large share of columns have a vertical-direction edge
  const rowFrac = new Float32Array(h);
  for (let y = 1; y < h - 1; y++) {
    let n = 0;
    for (let x = 0; x < w; x++) if (Math.abs(g[(y + 1) * w + x] - g[(y - 1) * w + x]) > EDGE_T) n++;
    rowFrac[y] = n / w;
  }
  const board = (y0: number, y1: number, lowest: boolean) => {
    let m = 0;
    for (let y = y0; y <= y1; y++) if (rowFrac[y] > m) m = rowFrac[y];
    if (m < 0.5) return null;
    if (lowest) { for (let y = y1; y >= y0; y--) if (rowFrac[y] >= 0.7 * m) return y; }
    else { for (let y = y0; y <= y1; y++) if (rowFrac[y] >= 0.7 * m) return y; }
    return null;
  };
  const ceilY = board(Math.round(h * 0.02), Math.round(h * 0.4), true);
  const floorY = board(Math.round(h * 0.6), Math.round(h * 0.98), false);

  let bt = (ceilY ?? 0) + 2, bb = floorY ?? h - 1;
  if (bb - bt < h * 0.2) { bt = 0; bb = h - 1; }
  const bh = bb - bt;

  // spine boundaries = peaks in the column edge profile over the lower part of the band
  const ya = Math.round(bt + bh * 0.35), yb = Math.round(bb - bh * 0.04);
  const V = new Float32Array(w);
  for (let x = 1; x < w - 1; x++) {
    let s = 0;
    for (let y = ya; y < yb; y++) s += Math.abs(g[y * w + x + 1] - g[y * w + x - 1]);
    V[x] = s / Math.max(1, yb - ya);
  }
  const S = new Float32Array(w);
  for (let x = 1; x < w - 1; x++) S[x] = (V[x - 1] + 2 * V[x] + V[x + 1]) / 4;
  let mean = 0; for (let x = 0; x < w; x++) mean += S[x]; mean /= w;
  let sd = 0; for (let x = 0; x < w; x++) sd += (S[x] - mean) ** 2; sd = Math.sqrt(sd / w);
  const thr = mean + 0.7 * sd, minW = Math.max(4, Math.round(w * 0.015));
  const peaks: number[] = [];
  for (let x = 2; x < w - 2; x++) {
    if (S[x] < thr || S[x] < S[x - 1] || S[x] <= S[x + 1]) continue;
    const p = peaks[peaks.length - 1];
    if (p !== undefined && x - p < minW) { if (S[x] > S[p]) peaks[peaks.length - 1] = x; } else peaks.push(x);
  }
  const bounds = [0, ...peaks, w - 1];
  const raw: { x0: number; x1: number }[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) raw.push({ x0: bounds[i], x1: bounds[i + 1] });
  const merged: { x0: number; x1: number }[] = [];
  for (const s of raw) {
    if (s.x1 - s.x0 < minW && merged.length) merged[merged.length - 1].x1 = s.x1; else merged.push({ ...s });
  }

  // top of each spine = first strong horizontal edge scanning down from the band top
  const yLim = Math.round(bt + bh * 0.75);
  const segs: Seg[] = merged.map(m => {
    const pad = Math.max(1, Math.round((m.x1 - m.x0) * 0.2));
    const xa = m.x0 + pad, xb = Math.max(xa + 1, m.x1 - pad);
    const R: number[] = []; let mx = 0;
    for (let y = bt; y < yLim; y++) {
      let s = 0; for (let x = xa; x < xb; x++) s += Math.abs(g[(y + 1) * w + x] - g[(y - 1) * w + x]);
      s /= xb - xa; R.push(s); if (s > mx) mx = s;
    }
    const th = Math.max(EDGE_T * 0.9, 0.5 * mx);
    let top = bt + Math.round(bh * 0.2);
    for (let i = 0; i < R.length; i++) if (R[i] > th) { top = bt + i; break; }
    return { x0: m.x0, x1: m.x1, top };
  });
  return { w, h, ceilY, floorY, bt, bb, segs };
}

/** Piano Tiles: up to 10 book keys nearest the centre of the frame (that's where you zoomed). */
export function detectPiano(src: CanvasImageSource, sw: number, sh: number): PianoResult {
  const a = analyze(src, sw, sh);
  const bh = a.bb - a.bt;
  const cand = a.segs.filter(s => a.bb - s.top >= bh * 0.3 && s.x1 - s.x0 >= 3);
  if (cand.length < 4) return { ok: false, msg: 'Looking for book spines…', regions: [] };
  const mid = a.w / 2;
  const picked = cand.sort((p, q) => Math.abs((p.x0 + p.x1) / 2 - mid) - Math.abs((q.x0 + q.x1) / 2 - mid)).slice(0, 10).sort((p, q) => p.x0 - q.x0);
  const regions: Region[] = picked.map((s, i) => ({
    id: `book-${i + 1}`, type: 'book',
    x: s.x0 / a.w, y: s.top / a.h, width: (s.x1 - s.x0) / a.w, height: (a.bb - s.top) / a.h,
  }));
  return { ok: true, msg: `${regions.length} books found`, regions };
}

/** Flappy Bird: corridor between the board above and the book tops below. Honest: fails when there is no gap. */
export function detectFlappy(src: CanvasImageSource, sw: number, sh: number, imgW: number, imgH: number, birdRadius: number): FlappyResult {
  const a = analyze(src, sw, sh);
  const fail = (msg: string): FlappyResult => ({ ok: false, msg, regions: [], scale: 1 });
  if (a.segs.length < 5) return fail('Zoom out a little — need more of the shelf in view');
  const ceil = a.ceilY ?? 0, floor = a.floorY ?? a.h - 1;
  const widths = a.segs.map(s => s.x1 - s.x0).sort((p, q) => p - q);
  const medW = widths[Math.floor(widths.length / 2)];
  const R = 0.3 * medW;                                  // bird radius, analysis px (scales with the books)

  const topAt = new Float32Array(a.w);
  a.segs.forEach((s, i) => {
    const x0 = i === 0 ? 0 : s.x0, x1 = i === a.segs.length - 1 ? a.w : s.x1;
    for (let x = x0; x < x1; x++) topAt[x] = s.top;
  });
  const free = (x: number) => topAt[x] - ceil;
  let best = { x0: 0, x1: -1 }, cur = -1;
  for (let x = 0; x <= a.w; x++) {
    const ok = x < a.w && free(x) >= 3.2 * R;
    if (ok && cur < 0) cur = x;
    if (!ok && cur >= 0) { if (x - 1 - cur > best.x1 - best.x0) best = { x0: cur, x1: x - 1 }; cur = -1; }
  }
  if (best.x1 - best.x0 < a.w * 0.4) return fail('No open gap between the shelf above and the books — need space over the book tops');
  const mids: number[] = []; for (let x = best.x0; x <= best.x1; x++) mids.push(free(x));
  mids.sort((p, q) => p - q);
  if (mids[Math.floor(mids.length / 2)] < 6 * R) return fail('Gap over the books is too tight for the bird');

  const len = best.x1 - best.x0;
  const sx = Math.min(best.x1, best.x0 + Math.round(len * 0.06));
  const gx0 = best.x1 >= a.w - 2 ? Math.round(a.w * 0.88) : best.x1 - Math.round(len * 0.1);
  const gx1 = best.x1 >= a.w - 2 ? Math.round(a.w * 0.98) : best.x1 - Math.round(len * 0.02);
  let gTop = a.h; for (let x = gx0; x <= gx1; x++) gTop = Math.min(gTop, topAt[x]);

  const N = (v: number, d: number) => +(v / d).toFixed(4);
  const regions: Region[] = [];
  if (ceil > 2) regions.push({ id: 'shelf-top', type: 'solid', x: 0, y: 0, width: 1, height: N(ceil, a.h) });
  if (a.floorY !== null) regions.push({ id: 'shelf-bottom', type: 'solid', x: 0, y: N(floor, a.h), width: 1, height: N(a.h - floor, a.h) });
  a.segs.forEach((s, i) => {
    const x0 = i === 0 ? 0 : s.x0, x1 = i === a.segs.length - 1 ? a.w : s.x1;
    regions.push({ id: `book-${i + 1}`, type: 'solid', x: N(x0, a.w), y: N(s.top, a.h), width: N(x1 - x0, a.w), height: N(floor - s.top, a.h) });
  });
  regions.push({ id: 'corridor', type: 'nav', x: N(best.x0, a.w), y: N(ceil, a.h), width: N(len, a.w), height: N(Math.min(...Array.from({ length: len + 1 }, (_, i) => topAt[best.x0 + i])) - ceil, a.h) });
  regions.push({ id: 'start', type: 'start', x: N(sx, a.w), y: N(ceil + free(sx) / 2, a.h), width: 0, height: 0 });
  regions.push({ id: 'goal', type: 'goal', x: N(gx0, a.w), y: N(ceil, a.h), width: N(gx1 - gx0, a.w), height: N(gTop - ceil, a.h) });
  // physics constants are tuned for R=6 image px; scale them so the bird is ~0.3 of a book width
  const scale = (R / a.w) * imgW / birdRadius;
  void imgH;
  return { ok: true, msg: 'Flight path found', regions, scale };
}
