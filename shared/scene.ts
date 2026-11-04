// What a game plays on: a still photo, or the live camera tracked against a locked reference frame.
// Games work in "world" pixels (the photo, or the camera frame at lock time); the scene draws the
// background into that world through the View, so game geometry and video stay aligned.
import { Rect, Region, View } from './geometry';
import { drawBackdrop } from './image';
import { Tracker } from './track';
import type { Px } from './detect';

export interface Scene {
  w: number; h: number; live: boolean;
  update(): void;                                   // once per frame, before draw
  draw(ctx: CanvasRenderingContext2D, view: View, W: number, H: number): void;
  window(): Rect;                                   // world area the camera frames right now
  lost(): boolean;                                  // tracking lost: gameplay should pause
}

/** A scanned environment handed to a game. */
export interface Live {
  scene: Scene;
  regions: Region[];
  scale?: number;                 // physics scale (bird size follows the book size)
  audio?: AudioContext | null;    // unlocked by a tap on the scan screen
  rescan: () => void;
}

export function photoScene(img: HTMLImageElement): Scene {
  const w = img.naturalWidth, h = img.naturalHeight;
  return {
    w, h, live: false,
    update() {},
    draw(ctx, view, W, H) { drawBackdrop(ctx, img, W, H); ctx.drawImage(img, view.ox, view.oy, w * view.scale, h * view.scale); },
    window: () => ({ x: 0, y: 0, width: w, height: h }),
    lost: () => false,
  };
}

/** Anything that produces camera-like frames: a <video>, or a canvas (simulated camera / uploaded photo). */
export interface Source { el: CanvasImageSource; w(): number; h(): number }

/** Downscaled RGBA copy of the current frame. */
export function grab(src: Source, width: number, c: HTMLCanvasElement): Px {
  const w = Math.min(width, src.w()), h = Math.max(1, Math.round(w * src.h() / src.w()));
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(src.el, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h);
  return { data: d.data, width: w, height: h };
}

const TRACK_W = 320;

export class LiveScene implements Scene {
  live = true;
  zoom = 1;
  readonly w: number; readonly h: number;
  /** where the current frame sits in the world (world px) */
  d = { x: 0, y: 0 };
  /** low-passed d: the framing follows slow pans but ignores hand shake */
  cam = { x: 0, y: 0 };
  motion = 0;
  private bad = 0;
  private k: number;
  private tracker: Tracker;
  private c = document.createElement('canvas');

  constructor(public src: Source) {
    this.w = src.w(); this.h = src.h();
    const ref = grab(src, TRACK_W, this.c);
    this.k = this.w / ref.width;
    this.tracker = new Tracker(ref);
  }

  update() {
    if (this.src.w() !== this.w || this.src.h() !== this.h) { this.bad = 99; return; }   // rotated / camera changed
    if (this.tracker.update(grab(this.src, TRACK_W, this.c))) {
      const x = this.tracker.dx * this.k, y = this.tracker.dy * this.k;
      this.motion = Math.hypot(x - this.d.x, y - this.d.y);
      this.d = { x, y }; this.bad = 0;
    } else this.bad++;
    this.cam.x += (this.d.x - this.cam.x) * 0.08;
    this.cam.y += (this.d.y - this.cam.y) * 0.08;
  }
  lost() { return this.bad > 6; }
  window(): Rect {
    const ww = this.w / this.zoom, wh = this.h / this.zoom;
    return { x: this.cam.x + (this.w - ww) / 2, y: this.cam.y + (this.h - wh) / 2, width: ww, height: wh };
  }
  draw(ctx: CanvasRenderingContext2D, view: View, W: number, H: number) {
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    ctx.drawImage(this.src.el, view.px(this.d.x), view.py(this.d.y), this.w * view.scale, this.h * view.scale);
  }
}
