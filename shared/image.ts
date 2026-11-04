const urls = import.meta.glob('../locations/**/*.{jpg,jpeg,png}', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

/** name is relative to /locations, e.g. "library/piano-bookshelf.jpg" */
export function loadImage(name: string): Promise<HTMLImageElement> {
  const url = urls[`../locations/${name}`];
  if (!url) return Promise.reject(new Error(`Image not found: ${name}`));
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error(`Failed to load ${name}`));
    img.src = url;
  });
}

/** Keeps the canvas backing store sharp; returns CSS size. */
export function fitCanvas(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) {
  const r = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w: r.width, h: r.height };
}

/** Blurred, darkened copy of the photo behind a letterboxed photo (no distortion of the real one). */
export function drawBackdrop(ctx: CanvasRenderingContext2D, img: HTMLImageElement, w: number, h: number) {
  ctx.fillStyle = '#0b0b0d';
  ctx.fillRect(0, 0, w, h);
  const s = Math.max(w / img.naturalWidth, h / img.naturalHeight);
  ctx.save();
  ctx.filter = 'blur(18px) brightness(0.45)';
  ctx.drawImage(img, (w - img.naturalWidth * s) / 2, (h - img.naturalHeight * s) / 2, img.naturalWidth * s, img.naturalHeight * s);
  ctx.restore();
}

