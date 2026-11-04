// Scan flow: 1) aim at the whole shelf -> auto-lock (analyse once, carefully)
//            2) pinch to zoom in on the live camera; detected books stay glued via tracking
//            3) game auto-starts and plays on the live video (restarts don't rescan)
import flappyCfg from '../games/flappy-bird/config.json';
import { Region, View, clamp, roundRect } from '../shared/geometry';
import { fitCanvas, loadImage } from '../shared/image';
import { analyzeShelf, flappyRegions, pianoRegions, FlappyLevel, Shelf } from '../shared/detect';
import { Live, LiveScene, Source, grab } from '../shared/scene';
import { Tracker } from '../shared/track';
import type { Px } from '../shared/detect';

type GameKey = 'piano' | 'flappy';
type Cam = Source & { stop(): void; truth?: { x: number; y: number } };

const CHECK_MS = 300;
const LOCK_CHECKS = 3;         // ~1 s of "shelf found + still" before auto-lock
const START_HOLD = 0.8;        // seconds steady at a good zoom before the game starts
const MIN_ZOOM = 1.3;

async function openCamera(): Promise<Cam> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false,
  });
  const v = document.createElement('video');
  v.playsInline = true; v.muted = true; v.setAttribute('playsinline', '');
  v.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
  document.body.appendChild(v);   // iOS only decodes frames for videos in the document
  v.srcObject = stream;
  await v.play();
  while (!v.videoWidth) await new Promise(r => setTimeout(r, 30));
  return { el: v, w: () => v.videoWidth, h: () => v.videoHeight, stop: () => { stream.getTracks().forEach(t => t.stop()); v.remove(); } };
}

/** A photo used as a camera. shake=true simulates a handheld phone (used for testing the live pipeline). */
function photoCam(img: HTMLImageElement, shake: boolean): Cam {
  const f = shake ? 0.85 : 1;
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * f); c.height = Math.round(img.naturalHeight * f);
  const g = c.getContext('2d')!, bx = (img.naturalWidth - c.width) / 2, by = (img.naturalHeight - c.height) / 2;
  const truth = { x: 0, y: 0 }, t0 = performance.now();
  let raf = 0;
  const loop = () => {
    raf = requestAnimationFrame(loop);
    const t = (performance.now() - t0) / 1000, a = c.width * 0.006;
    truth.x = shake ? a * (1.6 * Math.sin(t * 5.3) + 0.8 * Math.sin(t * 13.1) + 2.5 * Math.sin(t * 0.45)) : 0;
    truth.y = shake ? a * (1.2 * Math.sin(t * 4.1) + 0.6 * Math.sin(t * 11.7)) : 0;
    g.drawImage(img, -(bx + truth.x), -(by + truth.y));
  };
  loop();
  return { el: c, w: () => c.width, h: () => c.height, stop: () => cancelAnimationFrame(raf), truth };
}

export function start(stage: HTMLElement) {
  const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
  let game: GameKey = params.get('game') === 'flappy' ? 'flappy' : 'piano';
  let alive = true, cam: Cam | null = null, camError = '';
  let audio: AudioContext | null = null;
  let stopGame: (() => void) | null = null, stopUI: (() => void) | null = null;

  const unlock = () => {
    try { if (!audio) audio = new (window.AudioContext || (window as any).webkitAudioContext)(); audio.resume(); } catch { /* no audio */ }
  };

  function setCam(c: Cam) { cam?.stop(); cam = c; camError = ''; }
  const demo = params.get('photo');
  if (demo) loadImage(demo).then(i => alive && setCam(photoCam(i, params.get('shake') === '1')));
  else if (!navigator.mediaDevices?.getUserMedia) camError = 'Camera needs HTTPS. Open the https:// link, or upload a photo.';
  else openCamera().then(c => alive ? setCam(c) : c.stop()).catch(() => { camError = 'Allow camera access (or upload a photo).'; });

  function mountUI() {
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
        <div class="step"></div>
        <div class="status"></div>
        <div class="row zoomrow" hidden><span>1×</span><input type="range" min="1" max="4" step="0.02" value="1" class="zoom"><span class="zv">1.0×</span></div>
        <div class="row"><button data-a="lock" class="primary">Lock shelf</button><button data-a="start" class="primary" hidden>Start</button>
          <button data-a="rescan" hidden>Rescan</button><button data-a="upload">Upload photo</button></div>
        <input type="file" accept="image/*" hidden>
      </div>`);
    const $ = <T extends HTMLElement>(s: string) => wrap.querySelector(s) as T;
    const stepEl = $<HTMLDivElement>('.step'), status = $<HTMLDivElement>('.status');
    const zoomRow = $<HTMLDivElement>('.zoomrow'), zoomEl = $<HTMLInputElement>('.zoom'), zv = $<HTMLSpanElement>('.zv');
    const btn = (a: string) => $<HTMLButtonElement>(`[data-a=${a}]`);
    const file = $<HTMLInputElement>('input[type=file]');

    let phase: 'aim' | 'zoom' = 'aim';
    let raf = 0, lastCheck = 0, good = 0, prevSmall: Px | null = null, flash = 0;
    let scene: LiveScene | null = null, keys: Region[] = [], level: FlappyLevel | null = null;
    let steadySince = 0;
    const small = document.createElement('canvas'), big = document.createElement('canvas');
    const view = new View(1, 1);

    const okFor = (s: Shelf | null) => {
      if (!s) return { ok: false, msg: 'Point at a bookshelf — fit the whole shelf in view' };
      if (game === 'piano') { const n = pianoRegions(s).length; return n >= 6 ? { ok: true, msg: `${n} books found` } : { ok: false, msg: 'Get closer — need at least 6 clear book spines' }; }
      const f = flappyRegions(s); return { ok: f.ok, msg: f.ok ? 'Flight path found' : f.msg };
    };

    function lock() {
      if (!cam) return;
      const px = grab(cam, 640, big);
      const s = analyzeShelf(px);
      const r = okFor(s);
      if (!s || !r.ok) { status.textContent = r.msg; return; }
      keys = pianoRegions(s); level = flappyRegions(s);
      scene = new LiveScene(cam);
      phase = 'zoom'; flash = 1; steadySince = 0; setZoom(1);
      sync();
    }
    function unlockShelf() { scene = null; phase = 'aim'; good = 0; prevSmall = null; sync(); }

    let SW = 1, SH = 1;   // last screen size
    /** books whose full width is on screen and at least 60% of their height */
    function visibleKeys(): Region[] {
      if (!scene) return [];
      const a = view.toNorm(0, 0), b = view.toNorm(SW, SH);
      return keys.filter(k => {
        const ov = Math.min(b.y, k.y + k.height) - Math.max(a.y, k.y);
        return k.x >= a.x - 0.002 && k.x + k.width <= b.x + 0.002 && ov >= k.height * 0.6;
      });
    }

    async function launch() {
      if (!scene || !cam) return;
      unlock();
      let live: Live;
      const rescan = () => { stopGame?.(); stopGame = null; mountUI(); };
      if (game === 'piano') {
        const ks = visibleKeys().slice(0, 12).map((k, i) => ({ ...k, id: `book-${i + 1}` }));
        if (ks.length < 4) { status.textContent = 'Zoom so 5–12 books fill the screen'; return; }
        live = { scene, regions: ks, audio, rescan };
      } else {
        if (!level?.ok) return;
        live = { scene, regions: level.regions, scale: level.birdR * scene.w / flappyCfg.birdRadius, audio, rescan };
      }
      cancelAnimationFrame(raf); stopUI = null; wrap.remove();
      const mod = game === 'piano' ? await import('../games/piano-tiles/game') : await import('../games/flappy-bird/game');
      if (alive) stopGame = mod.start(stage, live);
    }

    function frame(ts: number) {
      if (!alive) return;
      raf = requestAnimationFrame(frame);
      const { w: W, h: H } = fitCanvas(canvas, ctx);
      SW = W; SH = H;
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
      if (!cam || !cam.w()) { status.textContent = camError || 'Starting camera…'; return; }

      if (phase === 'aim') {
        view.iw = cam.w(); view.ih = cam.h(); view.contain(W, H);
        ctx.drawImage(cam.el, view.ox, view.oy, cam.w() * view.scale, cam.h() * view.scale);
        if (ts - lastCheck > CHECK_MS) {
          lastCheck = ts;
          const px = grab(cam, 320, small);
          // steadiness = real camera motion between checks (hand shake is fine, fast pans are not)
          let motion = 99;
          if (prevSmall && prevSmall.width === px.width && prevSmall.height === px.height) {
            const t = new Tracker(prevSmall); t.update(px);
            motion = t.ok ? Math.hypot(t.dx, t.dy) / px.width : 99;
          }
          prevSmall = { data: new Uint8ClampedArray(px.data), width: px.width, height: px.height };
          const r = okFor(analyzeShelf(px));
          const steady = motion < 0.04;
          good = r.ok && steady ? good + 1 : 0;
          status.textContent = !r.ok ? r.msg : steady ? `${r.msg} — locking…` : `${r.msg} — hold still`;
          if (good >= LOCK_CHECKS) lock();
        }
        // guide frame + lock progress
        ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.setLineDash([10, 8]); ctx.lineWidth = 2;
        roundRect(ctx, { x: W * 0.06, y: H * 0.18, width: W * 0.88, height: H * 0.5 }, 14); ctx.stroke(); ctx.setLineDash([]);
        if (good > 0) {
          ctx.strokeStyle = '#ffd66e'; ctx.lineWidth = 5; ctx.beginPath();
          ctx.arc(W / 2, H * 0.43, 34, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, good / LOCK_CHECKS)); ctx.stroke();
        }
      } else if (scene) {
        scene.update();
        view.iw = scene.w; view.ih = scene.h; view.fit(scene.window(), W, H, 'contain');
        scene.draw(ctx, view, W, H);
        const lost = scene.lost();
        // glued overlay
        ctx.save(); ctx.lineWidth = 2;
        if (game === 'piano') {
          const vis = new Set(visibleKeys());
          for (const k of keys) {
            const r = view.rect(k); ctx.strokeStyle = vis.has(k) ? 'rgba(255,214,110,.95)' : 'rgba(255,255,255,.35)';
            roundRect(ctx, r, 3); ctx.stroke();
          }
        } else if (level?.ok) {
          for (const r of level.regions) {
            const s = view.rect(r);
            if (r.type === 'nav') { ctx.strokeStyle = 'rgba(77,210,255,.9)'; ctx.setLineDash([8, 6]); ctx.strokeRect(s.x, s.y, s.width, s.height); ctx.setLineDash([]); }
            else if (r.type === 'goal') { ctx.fillStyle = 'rgba(90,255,150,.3)'; ctx.fillRect(s.x, s.y, s.width, s.height); }
            else if (r.type === 'start') { ctx.fillStyle = '#6bff6b'; ctx.beginPath(); ctx.arc(view.sx(r.x), view.sy(r.y), 8, 0, 7); ctx.fill(); }
            else if (r.id.startsWith('book')) { ctx.strokeStyle = 'rgba(255,214,110,.6)'; roundRect(ctx, s, 3); ctx.stroke(); }
          }
        }
        ctx.restore();

        // auto-start: good zoom, held steady
        let ready = false;
        if (lost) status.textContent = 'Lost the shelf — point back at it';
        else if (game === 'piano') {
          const n = visibleKeys().length;
          ready = scene.zoom >= MIN_ZOOM && n >= 5 && n <= 12;
          status.textContent = scene.zoom < MIN_ZOOM ? 'Pinch to zoom in on the books' : n < 5 ? `${n} books in view — zoom out a little` : n > 12 ? `${n} books in view — zoom in more` : `${n} books — hold still`;
        } else {
          ready = !!level?.ok && scene.zoom >= MIN_ZOOM;
          status.textContent = !level?.ok ? `${level?.msg ?? ''}. Try Piano Tiles or rescan.` : scene.zoom < MIN_ZOOM ? 'Pinch to zoom in on the gap above the books' : 'Hold still…';
        }
        if (ready && scene.motion < 4) { if (!steadySince) steadySince = ts; } else steadySince = 0;
        if (steadySince && (ts - steadySince) / 1000 >= START_HOLD) { steadySince = 0; launch(); return; }
        if (steadySince) {
          ctx.strokeStyle = '#ffd66e'; ctx.lineWidth = 5; ctx.beginPath();
          ctx.arc(W / 2, H / 2, 34, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, (ts - steadySince) / 1000 / START_HOLD)); ctx.stroke();
        }
      }
      if (flash > 0) { ctx.fillStyle = `rgba(255,255,255,${flash * 0.7})`; ctx.fillRect(0, 0, W, H); flash = Math.max(0, flash - 0.06); }
    }

    function setZoom(z: number) {
      const v = clamp(z, 1, 4);
      if (scene) scene.zoom = v;
      zoomEl.value = String(v); zv.textContent = v.toFixed(1) + '×';
    }
    function sync() {
      wrap.querySelectorAll('[data-g]').forEach(b => b.classList.toggle('on', b.getAttribute('data-g') === game));
      stepEl.textContent = phase === 'aim' ? 'Step 1 · Point at the whole shelf' : 'Step 2 · Zoom in to play';
      zoomRow.hidden = phase !== 'zoom';
      btn('lock').hidden = phase !== 'aim'; btn('upload').hidden = phase !== 'aim';
      btn('start').hidden = phase !== 'zoom'; btn('rescan').hidden = phase !== 'zoom';
    }
    sync();

    zoomEl.oninput = () => setZoom(+zoomEl.value);
    const pts = new Map<number, { x: number; y: number }>(); let pinch0 = 0, zoom0 = 1;
    canvas.addEventListener('pointerdown', e => {
      unlock(); pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch0 = Math.hypot(a.x - b.x, a.y - b.y) || 1; zoom0 = scene?.zoom ?? 1; }
    });
    canvas.addEventListener('pointermove', e => {
      if (!pts.has(e.pointerId)) return; pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2 && phase === 'zoom') { const [a, b] = [...pts.values()]; setZoom(zoom0 * Math.hypot(a.x - b.x, a.y - b.y) / pinch0); }
    });
    const up = (e: PointerEvent) => pts.delete(e.pointerId);
    canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('wheel', e => { e.preventDefault(); if (phase === 'zoom') setZoom((scene?.zoom ?? 1) * (e.deltaY < 0 ? 1.06 : 0.94)); }, { passive: false });

    wrap.querySelectorAll('button').forEach(b => (b as HTMLButtonElement).onclick = () => {
      unlock();
      const g = b.getAttribute('data-g') as GameKey | null, a = b.getAttribute('data-a');
      if (g) { game = g; good = 0; steadySince = 0; sync(); }
      if (a === 'home') location.hash = '';
      if (a === 'rec') document.body.classList.toggle('rec');
      if (a === 'lock') lock();
      if (a === 'start') launch();
      if (a === 'rescan') unlockShelf();
      if (a === 'upload') file.click();
    });
    file.onchange = () => {
      const f = file.files?.[0]; if (!f) return;
      const i = new Image(); i.onload = () => { setCam(photoCam(i, false)); unlockShelf(); }; i.src = URL.createObjectURL(f);
    };

    raf = requestAnimationFrame(frame);
    stopUI = () => { cancelAnimationFrame(raf); wrap.remove(); };
    (window as any).__scan = {
      get phase() { return phase; }, status: () => status.textContent, setZoom, lock, launch,
      scene: () => scene, truth: () => cam?.truth, keys: () => keys, level: () => level,
    };
  }

  mountUI();
  return () => { alive = false; stopUI?.(); stopGame?.(); cam?.stop(); document.body.classList.remove('rec', 'playing'); };
}
