// Shelf analysis from raw RGBA pixels (no canvas, no ML), so it is fast and unit-testable.
// Spine boundaries come from column colour statistics (book-to-book colour change, dark seams,
// long vertical edges) averaged over the shelf height, so title text on a spine doesn't split it.
import type { Region } from './geometry';

export interface Px { data: Uint8ClampedArray | Uint8Array; width: number; height: number }
export interface Book { x0: number; x1: number; top: number; edge: boolean }
export interface Shelf {
  w: number; h: number;
  top: number;        // lower edge of the board above (or estimated band top if no board)
  bottom: number;     // where the books stand
  ceiling: boolean;   // a real board was found above the books
  books: Book[];
}

const T = 18;

function smooth(a: Float32Array, r: number) {
  const o = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) {
    let s = 0, n = 0;
    for (let j = Math.max(0, i - r); j <= Math.min(a.length - 1, i + r); j++) { s += a[j]; n++; }
    o[i] = s / n;
  }
  return o;
}
function quantile(a: Float32Array, q: number) {
  const s = Array.from(a).sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] || 1e-6;
}

export function analyzeShelf(img: Px, focusY = 0.5): Shelf | null {
  const { width: w, height: h, data } = img;
  const n = w * h;
  const R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n), Y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    R[i] = r; G[i] = g; B[i] = b; Y[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }

  // Row profiles: hLine = share of columns with a horizontal edge (shelf boards),
  // vDen = share of columns with a vertical edge (rows full of spines).
  const hLine = new Float32Array(h), vDen = new Float32Array(h);
  for (let y = 1; y < h - 1; y++) {
    let a = 0, b = 0;
    const o = y * w;
    for (let x = 1; x < w - 1; x++) {
      if (Math.abs(Y[o + w + x] - Y[o - w + x]) > T) a++;
      if (Math.abs(Y[o + x + 1] - Y[o + x - 1]) > T) b++;
    }
    hLine[y] = a / w; vDen[y] = b / w;
  }
  const vS = smooth(vDen, Math.max(2, Math.round(h * 0.02)));

  // The book row = the band of dense vertical structure nearest the focus point.
  let seed = 1, best = -1;
  for (let y = 1; y < h - 1; y++) {
    const s = vS[y] * (1 - 0.8 * Math.abs(y / h - focusY));
    if (s > best) { best = s; seed = y; }
  }
  if (vS[seed] < 0.08) return null;
  const lim = vS[seed] * 0.45;
  let rt = seed, rb = seed;
  while (rt > 1 && vS[rt - 1] >= lim) rt--;
  while (rb < h - 2 && vS[rb + 1] >= lim) rb++;
  if (rb - rt < h * 0.12) return null;

  // Floor = strongest long horizontal line near the bottom of the book band.
  let floorY = -1, fm = 0.3;
  for (let y = Math.max(1, rb - Math.round(h * 0.06)); y <= Math.min(h - 2, rb + Math.round(h * 0.08)); y++) {
    if (hLine[y] > fm) { fm = hLine[y]; floorY = y; }
  }
  const bottom = floorY > 0 ? floorY : rb;

  // Ceiling = first long horizontal line above the band (skipping the book-tops edge itself).
  let ceilY = -1;
  for (let y = rt - Math.max(2, Math.round(h * 0.015)); y >= 1; y--) {
    if (hLine[y] >= 0.4 && hLine[y] >= hLine[y - 1] && hLine[y] >= hLine[y + 1]) { ceilY = y; break; }
  }
  const top = ceilY > 0 ? ceilY + 1 : Math.max(0, rt - Math.round((rb - rt) * 0.35));
  const bandH = bottom - rt;

  // Column statistics over the lower part of the band, where every book is present.
  const ya = Math.round(bottom - bandH * 0.6), yb = Math.round(bottom - bandH * 0.05);
  const rows = Math.max(1, yb - ya);
  const cR = new Float32Array(w), cG = new Float32Array(w), cB = new Float32Array(w), cY = new Float32Array(w), coh = new Float32Array(w);
  for (let y = ya; y < yb; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      cR[x] += R[o + x]; cG[x] += G[o + x]; cB[x] += B[o + x]; cY[x] += Y[o + x];
      if (x > 0 && x < w - 1 && Math.abs(Y[o + x + 1] - Y[o + x - 1]) > T) coh[x]++;
    }
  }
  for (let x = 0; x < w; x++) { cR[x] /= rows; cG[x] /= rows; cB[x] /= rows; cY[x] /= rows; coh[x] /= rows; }

  // prefix sums for windowed means
  const pre = (a: Float32Array) => { const p = new Float32Array(w + 1); for (let i = 0; i < w; i++) p[i + 1] = p[i] + a[i]; return p; };
  const pR = pre(cR), pG = pre(cG), pB = pre(cB);
  const mean = (p: Float32Array, a: number, b: number) => { a = Math.max(0, a); b = Math.min(w - 1, b); return b < a ? 0 : (p[b + 1] - p[a]) / (b - a + 1); };
  const k = Math.max(2, Math.round(w * 0.006));
  const D = new Float32Array(w), V = new Float32Array(w);
  for (let x = k + 2; x < w - k - 2; x++) {
    const dr = mean(pR, x - k - 1, x - 2) - mean(pR, x + 2, x + k + 1);
    const dg = mean(pG, x - k - 1, x - 2) - mean(pG, x + 2, x + k + 1);
    const db = mean(pB, x - k - 1, x - 2) - mean(pB, x + 2, x + k + 1);
    D[x] = Math.sqrt(dr * dr + dg * dg + db * db);
    const side = (cY[x - k] + cY[x + k]) / 2;
    V[x] = Math.max(0, side - Math.min(cY[x - 1], cY[x], cY[x + 1]));
  }
  const qD = quantile(D, 0.9), qV = quantile(V, 0.9), qC = quantile(coh, 0.9);
  const S = new Float32Array(w);
  for (let x = 0; x < w; x++) S[x] = D[x] / qD + 0.7 * V[x] / qV + coh[x] / qC;
  const thr = Math.max(0.9, quantile(S, 0.5) * 1.6);

  // Non-max suppression: strongest boundaries first, at least minSep apart.
  const minSep = Math.max(3, Math.round(w * 0.012));
  const order = Array.from(S.keys()).filter(x => S[x] > thr && x > 1 && x < w - 2).sort((a, b) => S[b] - S[a]);
  const taken = new Uint8Array(w), peaks: number[] = [];
  for (const x of order) {
    let clear = true;
    for (let j = Math.max(0, x - minSep); j <= Math.min(w - 1, x + minSep); j++) if (taken[j]) { clear = false; break; }
    if (clear) { taken[x] = 1; peaks.push(x); }
  }
  peaks.sort((a, b) => a - b);
  const bounds = [0, ...peaks, w - 1];

  // Book tops: first sustained colour change below the band top, per spine.
  const rowColor = (y: number, xa: number, xb: number) => {
    let r = 0, g = 0, b = 0; const o = y * w;
    for (let x = xa; x < xb; x++) { r += R[o + x]; g += G[o + x]; b += B[o + x]; }
    const m = xb - xa; return [r / m, g / m, b / m];
  };
  const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const books: Book[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const x0 = bounds[i], x1 = bounds[i + 1];
    if (x1 - x0 < 2) continue;
    const pad = Math.max(1, Math.round((x1 - x0) * 0.25));
    const xa = x0 + pad, xb = Math.max(xa + 1, x1 - pad);
    // reference colour sampled a little below the board so its soft/blurred edge isn't mistaken for background
    const r0 = Math.min(bottom - 8, top + Math.max(3, Math.round(h * 0.02)));
    const c0 = rowColor(r0, xa, xb), c1 = rowColor(r0 + 1, xa, xb), c2 = rowColor(r0 + 2, xa, xb);
    const ref = [0, 1, 2].map(j => (c0[j] + c1[j] + c2[j]) / 3);
    let bt = top;
    for (let y = r0 + 3; y < bottom - 6; y++) {
      if (dist(rowColor(y, xa, xb), ref) > 30 && dist(rowColor(y + 3, xa, xb), ref) > 30 && dist(rowColor(y + 6, xa, xb), ref) > 25) { bt = y; break; }
    }
    bt = Math.min(bt, Math.round(bottom - (bottom - top) * 0.15));
    books.push({ x0, x1, top: bt, edge: i === 0 || i + 2 === bounds.length });
  }
  return { w, h, top, bottom, ceiling: ceilY > 0, books };
}

/** Piano keys: non-edge spines, normalized to the analysed image. */
export function pianoRegions(s: Shelf): Region[] {
  const ws = s.books.filter(b => !b.edge).map(b => b.x1 - b.x0).sort((a, b) => a - b);
  const med = ws[Math.floor(ws.length / 2)] || 1;
  return s.books
    .filter(b => !b.edge && b.x1 - b.x0 >= med * 0.35 && b.x1 - b.x0 <= med * 4 && s.bottom - b.top >= (s.bottom - s.top) * 0.3)
    .map((b, i) => ({ id: `book-${i + 1}`, type: 'book', x: b.x0 / s.w, y: b.top / s.h, width: (b.x1 - b.x0) / s.w, height: (s.bottom - b.top) / s.h }));
}

export interface FlappyLevel { ok: boolean; msg: string; regions: Region[]; birdR: number /* normalized to width */ }

/** Flappy: corridor between the board above and the book tops. Fails honestly if there is no gap. */
export function flappyRegions(s: Shelf): FlappyLevel {
  const fail = (msg: string): FlappyLevel => ({ ok: false, msg, regions: [], birdR: 0 });
  if (s.books.length < 5) return fail('Need more of the shelf in view');
  if (!s.ceiling) return fail('Include the shelf board above the books');
  const ws = s.books.map(b => b.x1 - b.x0).sort((a, b) => a - b);
  const R = 0.3 * ws[Math.floor(ws.length / 2)];
  const topAt = new Float32Array(s.w);
  for (const b of s.books) for (let x = b.x0; x <= b.x1 && x < s.w; x++) topAt[x] = b.top;
  const free = (x: number) => topAt[x] - s.top;
  let best = { x0: 0, x1: -1 }, cur = -1;
  for (let x = 0; x <= s.w; x++) {
    const ok = x < s.w && free(x) >= 3.2 * R;
    if (ok && cur < 0) cur = x;
    if (!ok && cur >= 0) { if (x - 1 - cur > best.x1 - best.x0) best = { x0: cur, x1: x - 1 }; cur = -1; }
  }
  if (best.x1 - best.x0 < s.w * 0.4) return fail('No open gap over the books — needs space between book tops and the shelf above');
  const fr: number[] = []; for (let x = best.x0; x <= best.x1; x++) fr.push(free(x));
  fr.sort((a, b) => a - b);
  if (fr[Math.floor(fr.length / 2)] < 6 * R) return fail('Gap over the books is too tight for the bird');

  const len = best.x1 - best.x0;
  const sx = best.x0 + Math.round(len * 0.06);
  const atEdge = best.x1 >= s.w - 2;
  const gx0 = atEdge ? Math.round(s.w * 0.88) : best.x1 - Math.round(len * 0.1);
  const gx1 = atEdge ? Math.round(s.w * 0.98) : best.x1 - Math.round(len * 0.02);
  let gTop = s.h; for (let x = gx0; x <= gx1; x++) gTop = Math.min(gTop, topAt[x]);
  let cTop = s.h; for (let x = best.x0; x <= best.x1; x++) cTop = Math.min(cTop, topAt[x]);
  const W = s.w, H = s.h;
  const regions: Region[] = [{ id: 'shelf-top', type: 'solid', x: 0, y: 0, width: 1, height: s.top / H }];
  regions.push({ id: 'shelf-bottom', type: 'solid', x: 0, y: s.bottom / H, width: 1, height: 1 - s.bottom / H });
  s.books.forEach((b, i) => regions.push({ id: `book-${i + 1}`, type: 'solid', x: b.x0 / W, y: b.top / H, width: (b.x1 - b.x0) / W, height: (s.bottom - b.top) / H }));
  regions.push({ id: 'corridor', type: 'nav', x: best.x0 / W, y: s.top / H, width: len / W, height: (cTop - s.top) / H });
  regions.push({ id: 'start', type: 'start', x: sx / W, y: (s.top + free(sx) / 2) / H, width: 0, height: 0 });
  regions.push({ id: 'goal', type: 'goal', x: gx0 / W, y: s.top / H, width: (gx1 - gx0) / W, height: (gTop - s.top) / H });
  return { ok: true, msg: 'Flight path found', regions, birdR: R / W };
}
