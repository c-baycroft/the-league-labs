// All annotated geometry is normalized (0..1 of the photo). View maps between
// normalized image space and CSS pixels on the canvas, so letterboxing and
// camera scrolling never misalign hit regions.

export interface Rect { x: number; y: number; width: number; height: number }
export interface Region extends Rect { id: string; type: string }

export class View {
  scale = 1; ox = 0; oy = 0;
  constructor(public iw: number, public ih: number) {}

  /** Whole photo visible, centred, aspect preserved. */
  contain(w: number, h: number) {
    this.scale = Math.min(w / this.iw, h / this.ih);
    this.ox = (w - this.iw * this.scale) / 2;
    this.oy = (h - this.ih * this.scale) / 2;
  }

  /** Photo fills the canvas height; camX = image pixel at the left edge. Falls back to contain if the photo is narrower than the canvas. */
  cover(w: number, h: number, camX: number) {
    const s = h / this.ih;
    if (this.iw * s <= w) return this.contain(w, h);
    const vis = w / s;
    camX = Math.max(0, Math.min(this.iw - vis, camX));
    this.scale = s; this.ox = -camX * s; this.oy = 0;
  }

  /** Centre world rect r on screen: 'cover' fills the screen, 'contain' keeps all of r visible. */
  fit(r: Rect, w: number, h: number, mode: 'cover' | 'contain' = 'cover') {
    this.scale = mode === 'cover' ? Math.max(w / r.width, h / r.height) : Math.min(w / r.width, h / r.height);
    this.ox = w / 2 - (r.x + r.width / 2) * this.scale;
    this.oy = h / 2 - (r.y + r.height / 2) * this.scale;
  }

  visibleImageWidth(w: number) { return w / this.scale; }

  /** normalized -> screen */
  sx(nx: number) { return this.ox + nx * this.iw * this.scale; }
  sy(ny: number) { return this.oy + ny * this.ih * this.scale; }
  rect(r: Rect): Rect {
    return { x: this.sx(r.x), y: this.sy(r.y), width: r.width * this.iw * this.scale, height: r.height * this.ih * this.scale };
  }
  /** screen -> normalized */
  toNorm(px: number, py: number) {
    return { x: (px - this.ox) / (this.iw * this.scale), y: (py - this.oy) / (this.ih * this.scale) };
  }
  /** image pixels -> screen */
  px(ix: number) { return this.ox + ix * this.scale; }
  py(iy: number) { return this.oy + iy * this.scale; }
}

export const contains = (r: Rect, x: number, y: number) =>
  x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;

export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export function circleHitsRect(cx: number, cy: number, rad: number, r: Rect) {
  const nx = clamp(cx, r.x, r.x + r.width), ny = clamp(cy, r.y, r.y + r.height);
  const dx = cx - nx, dy = cy - ny;
  return dx * dx + dy * dy < rad * rad;
}

export function roundRect(ctx: CanvasRenderingContext2D, r: Rect, rad: number) {
  const k = Math.min(rad, r.width / 2, r.height / 2);
  ctx.beginPath();
  ctx.moveTo(r.x + k, r.y);
  ctx.arcTo(r.x + r.width, r.y, r.x + r.width, r.y + r.height, k);
  ctx.arcTo(r.x + r.width, r.y + r.height, r.x, r.y + r.height, k);
  ctx.arcTo(r.x, r.y + r.height, r.x, r.y, k);
  ctx.arcTo(r.x, r.y, r.x + r.width, r.y, k);
  ctx.closePath();
}
