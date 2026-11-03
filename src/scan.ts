// Scan screen: live camera (or an uploaded photo) -> zoom -> auto-detect -> game starts on a frozen snapshot.
import pianoCfg from '../games/piano-tiles/config.json';
import flappyCfg from '../games/flappy-bird/config.json';
import { View, Region, clamp, roundRect } from '../shared/geometry';
import { Live, canvasToImage, fitCanvas, loadImage } from '../shared/image';
import { detectFlappy, detectPiano } from '../shared/detect';

type GameKey = 'piano' | 'flappy';
const STABLE_NEEDED = 4;          // consecutive good detections (~1.2 s) before auto-start
const CHECK_MS = 300;
const MAX_SIDE = 1600;

export function start(stage: HTMLElement) {
  const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
  let game: GameKey = params.get('game') === 'flappy' ? 'flappy' : 'piano';
  let alive = true, raf = 0;
  let stopGame: (() => void) | null = null;
  let teardown: (() => void) | null = null;

  async function launch(kind: GameKey, live: Live) {
    teardown?.(); teardown = null;
    const mod = kind === 'piano' ? await import('../games/piano-tiles/game') : await import('../games/flappy-bird/game');
    if (!alive) return;
    stopGame = (mod as any).start(stage, live);
  }

  function mount() {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:absolute;inset:0';
    stage.appendChild(wrap);
    const canvas = document.createElement('canvas');
    wrap.appendChild(canvas);
    const ctx = canvas.getContext('2d')!;
    wrap.insertAdjacentHTML('beforeend', `
      <div class="topbar"><div><button data-a="home">Home</button></div>
        <div><button data-g="piano">Piano Tiles</button><button data-g="flappy">Flappy Bird</button><button data-a="rec">9:16</button></div></div>
      <div class="scanbar">
        <div class="status"></div>
        <div class="row"><span>1×</span><input type="range" min="1" max="5" step="0.05" value="1" class="zoom"><span class="zv">1.0×</span></div>
        <div class="row"><button data-a="play" class="primary">Play now</button><button data-a="upload">Upload photo</button></div>
        <input type="file" accept="image/*" hidden>
      </div>`);
    const $ = <T extends HTMLElement>(s: string) => wrap.querySelector(s) as T;
    const status = $<HTMLDivElement>('.status'), zoomEl = $<HTMLInputElement>('.zoom'), zv = $<HTMLSpanElement>('.zv');
    const file = $<HTMLInputElement>('input[type=file]');

    let audio: AudioContext | null = null;
    const unlock = () => {
      try {
        if (!audio) audio = new (window.AudioContext || (window as any).webkitAudioContext)();
        audio.resume();
      } catch { /* no audio is fine */ }
    };

    // ---- source: camera stream or still image ----
    const video = document.createElement('video');
    video.playsInline = true; video.muted = true;
    let stream: MediaStream | null = null;
    let still: HTMLImageElement | null = null;
    let camError = '';
    let zoom = 1;

    const srcSize = () => still ? { el: still as CanvasImageSource, w: still.naturalWidth, h: still.naturalHeight }
      : video.videoWidth ? { el: video as CanvasImageSource, w: video.videoWidth, h: video.videoHeight } : null;

    async function openCamera() {
      if (!navigator.mediaDevices?.getUserMedia) { camError = 'Camera needs HTTPS — open the https:// link, or upload a photo.'; return; }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
        video.srcObject = stream; await video.play();
      } catch (e) { camError = 'Camera blocked or unavailable — allow camera access, or upload a photo.'; }
    }

    /** The zoomed crop (centre of the source) at capture resolution. */
    function crop(maxSide: number) {
      const s = srcSize(); if (!s) return null;
      const cw = s.w / zoom, ch = s.h / zoom, cx0 = (s.w - cw) / 2, cy0 = (s.h - ch) / 2;
      const k = Math.min(1, maxSide / Math.max(cw, ch));
      const c = document.createElement('canvas'); c.width = Math.round(cw * k); c.height = Math.round(ch * k);
      c.getContext('2d')!.drawImage(s.el, cx0, cy0, cw, ch, 0, 0, c.width, c.height);
      return c;
    }

    function detect(c: HTMLCanvasElement): { ok: boolean; msg: string; regions: Region[]; scale?: number } {
      return game === 'piano'
        ? detectPiano(c, c.width, c.height)
        : detectFlappy(c, c.width, c.height, c.width, c.height, flappyCfg.birdRadius);
    }

    // ---- loop ----
    let result: ReturnType<typeof detect> | null = null, stable = 0, lastCheck = 0, busy = false;
    const view = new View(1, 1);
    let frameC: HTMLCanvasElement | null = null;

    async function go(c: HTMLCanvasElement, r: ReturnType<typeof detect>) {
      if (busy) return; busy = true;
      unlock();
      const image = await canvasToImage(c);
      cancelAnimationFrame(raf); stream?.getTracks().forEach(t => t.stop());
      const live: Live = { image, regions: r.regions, scale: r.scale, audio, rescan: () => { stopGame?.(); stopGame = null; mount(); } };
      await launch(game, live);
    }

    function frame(ts: number) {
      if (!alive) return;
      raf = requestAnimationFrame(frame);
      const { w, h } = fitCanvas(canvas, ctx);
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
      const c = crop(1280);
      if (!c) { status.textContent = camError || 'Starting camera…'; return; }
      frameC = c;
      view.iw = c.width; view.ih = c.height; view.contain(w, h);
      ctx.drawImage(c, view.ox, view.oy, c.width * view.scale, c.height * view.scale);

      if (ts - lastCheck > CHECK_MS && !busy) {
        lastCheck = ts;
        const r = detect(c);
        stable = r.ok ? stable + 1 : 0;
        result = r;
        status.textContent = r.ok ? (stable >= STABLE_NEEDED ? 'Starting…' : `${r.msg} — hold steady`) : r.msg;
        if (stable >= STABLE_NEEDED && alive) go(c, r);
      }
      if (result?.ok) overlay(result.regions);
    }

    function overlay(regions: Region[]) {
      ctx.save(); ctx.lineWidth = 2;
      for (const r of regions) {
        if (r.type === 'book' || (game === 'flappy' && r.id.startsWith('book'))) {
          const s = view.rect(r); ctx.strokeStyle = 'rgba(255,214,110,.95)'; ctx.fillStyle = 'rgba(255,214,110,.18)';
          roundRect(ctx, s, 3); ctx.fill(); ctx.stroke();
        } else if (r.type === 'nav') {
          const s = view.rect(r); ctx.strokeStyle = 'rgba(77,210,255,.9)'; ctx.setLineDash([6, 4]); ctx.strokeRect(s.x, s.y, s.width, s.height); ctx.setLineDash([]);
        } else if (r.type === 'goal') {
          const s = view.rect(r); ctx.fillStyle = 'rgba(90,255,150,.3)'; ctx.fillRect(s.x, s.y, s.width, s.height);
        } else if (r.type === 'start') {
          ctx.fillStyle = '#6bff6b'; ctx.beginPath(); ctx.arc(view.sx(r.x), view.sy(r.y), 7, 0, 7); ctx.fill();
        }
      }
      ctx.restore();
    }

    // ---- controls ----
    const setZoom = (z: number) => { zoom = clamp(z, 1, 5); zoomEl.value = String(zoom); zv.textContent = zoom.toFixed(1) + '×'; stable = 0; };
    zoomEl.oninput = () => setZoom(+zoomEl.value);
    const pts = new Map<number, { x: number; y: number }>(); let pinch0 = 0, zoom0 = 1;
    canvas.addEventListener('pointerdown', e => {
      unlock(); pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch0 = Math.hypot(a.x - b.x, a.y - b.y); zoom0 = zoom; }
    });
    canvas.addEventListener('pointermove', e => {
      if (!pts.has(e.pointerId)) return; pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2) { const [a, b] = [...pts.values()]; setZoom(zoom0 * Math.hypot(a.x - b.x, a.y - b.y) / pinch0); }
    });
    const up = (e: PointerEvent) => pts.delete(e.pointerId);
    canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('wheel', e => { e.preventDefault(); setZoom(zoom * (e.deltaY < 0 ? 1.08 : 0.93)); }, { passive: false });

    const sync = () => wrap.querySelectorAll('[data-g]').forEach(b => b.classList.toggle('on', b.getAttribute('data-g') === game));
    sync();
    wrap.querySelectorAll('button').forEach(b => (b as HTMLButtonElement).onclick = () => {
      unlock();
      const g = b.getAttribute('data-g') as GameKey | null, a = b.getAttribute('data-a');
      if (g) { game = g; stable = 0; result = null; sync(); }
      if (a === 'home') location.hash = '';
      if (a === 'rec') document.body.classList.toggle('rec');
      if (a === 'upload') file.click();
      if (a === 'play' && frameC) {
        const full = crop(MAX_SIDE)!, r = detect(full);
        if (r.ok) go(full, r); else status.textContent = r.msg + ' (zoom or move, then try again)';
      }
    });
    file.onchange = () => {
      const f = file.files?.[0]; if (!f) return;
      const i = new Image(); i.onload = () => { still = i; setZoom(1); stable = 0; }; i.src = URL.createObjectURL(f);
    };

    // test / demo hook: #scan?photo=library/xyz.jpg&game=flappy
    const demo = params.get('photo');
    if (demo) loadImage(demo).then(i => { still = i; }); else openCamera();
    raf = requestAnimationFrame(frame);

    teardown = () => { cancelAnimationFrame(raf); stream?.getTracks().forEach(t => t.stop()); wrap.remove(); };
  }

  mount();
  return () => { alive = false; teardown?.(); stopGame?.(); document.body.classList.remove('rec', 'playing'); };
}
void pianoCfg;
