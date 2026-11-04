import config from './config.json';
import { Rect, Region, View, contains, roundRect } from '../../shared/geometry';
import { fitCanvas, loadImage } from '../../shared/image';
import { Live, Scene, photoScene } from '../../shared/scene';
import { Annotator, editorBar, loadSaved, onPress } from '../../shared/input';

const STORE = 'league.piano.regions';
const BEST = 'league.piano.best';
const COUNT_STEP = 0.7;   // seconds per countdown number
const GRACE = 0.06;       // forgiveness after a note's deadline
const PENT = [0, 2, 4, 7, 9];

interface Note { book: number; lit: number; dead: number; hit: boolean }
interface Spark { x: number; y: number; vx: number; vy: number; life: number }

export function start(stage: HTMLElement, live?: Live) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  stage.appendChild(canvas);

  let scene: Scene, view: View, W = 1, H = 1;
  let pausedAt: number | null = null;   // live tracking lost: freeze the song
  let state: 'ready' | 'count' | 'play' | 'over' = 'ready';
  let audio: AudioContext | null = null;
  let raf = 0, alive = true;

  const store = live ? STORE + '.live' : STORE;
  const saved = live ? null : loadSaved(STORE);
  const regions: Region[] = (live ? live.regions : (saved ?? (config.regions as Region[]))).filter(r => r.type === 'book');
  const ann = new Annotator(canvas, () => view, [{ kind: 'book', color: '#ffd66e' }], regions);
  const books = () => ann.regions.slice().sort((a, b) => a.x - b.x);

  // ---- game state (all times on the audio clock) ----
  let notes: Note[] = [];
  let t0 = 0, noteCount = 0, lastBook = -1, nextLit = 0;
  let score = 0, best = +(localStorage.getItem(BEST) ?? 0);
  let missedBook = -1, overAt = 0, shake = 0;
  let sparks: Spark[] = [];
  const hitFlash = new Map<number, number>();

  const clock = () => (audio ? audio.currentTime : performance.now() / 1000);

  // ---- audio ----
  function tone(book: number, when = 0) {
    if (!audio) return;
    const semis = PENT[book % 5] + 12 * Math.floor(book / 5);
    const f = 261.63 * Math.pow(2, semis / 12);
    const t = audio.currentTime + when;
    const g = audio.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.45, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    g.connect(audio.destination);
    for (const [mult, vol, type] of [[1, 1, 'triangle'], [2, 0.35, 'sine'], [3, 0.12, 'sine']] as const) {
      const o = audio.createOscillator(), og = audio.createGain();
      o.type = type; o.frequency.value = f * mult; og.gain.value = vol;
      o.connect(og); og.connect(g); o.start(t); o.stop(t + 0.95);
    }
  }
  function buzz() {
    if (!audio) return;
    const t = audio.currentTime, o = audio.createOscillator(), g = audio.createGain();
    o.type = 'sawtooth'; o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(55, t + 0.35);
    g.gain.setValueAtTime(0.25, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    o.connect(g); g.connect(audio.destination); o.start(t); o.stop(t + 0.42);
  }
  function tick(high: boolean) {
    if (!audio) return;
    const t = audio.currentTime, o = audio.createOscillator(), g = audio.createGain();
    o.frequency.value = high ? 1046 : 660; g.gain.setValueAtTime(0.2, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    o.connect(g); g.connect(audio.destination); o.start(t); o.stop(t + 0.14);
  }

  // ---- note generation ----
  const interval = (n: number) => Math.max(config.minInterval, config.startInterval * Math.pow(config.speedUp, n));
  function genNote() {
    const n = books().length;
    let b: number;
    if (lastBook < 0) b = Math.floor(n / 2);
    else do { b = Math.max(0, Math.min(n - 1, lastBook + Math.round((Math.random() - 0.5) * 7))); } while (b === lastBook);
    const iv = interval(noteCount++);
    notes.push({ book: b, lit: nextLit, dead: nextLit + iv, hit: false });
    nextLit += iv; lastBook = b;
  }

  function begin() {
    if (!audio) audio = live?.audio ?? new (window.AudioContext || (window as any).webkitAudioContext)();
    audio.resume();
    notes = []; noteCount = 0; lastBook = -1; score = 0; missedBook = -1; sparks = []; hitFlash.clear();
    t0 = clock();
    nextLit = t0 + COUNT_STEP * 3 + 0.35;
    state = 'count';
    document.body.classList.add('playing');
    ui.hidden = true; overUi.hidden = true;
  }

  function gameOver(book: number) {
    if (state !== 'play') return;
    state = 'over'; missedBook = book; overAt = performance.now(); shake = 1;
    buzz();
    if (score > best) { best = score; localStorage.setItem(BEST, String(best)); }
    document.body.classList.remove('playing');
    overUi.querySelector('.score')!.textContent = String(score);
    overUi.querySelector('.best')!.textContent = `Best ${best}`;
    overUi.hidden = false;
  }

  function burst(r: Rect) {
    const cx = r.x + r.width / 2;
    for (let i = 0; i < 18; i++) {
      const a = Math.random() * Math.PI * 2, s = 60 + Math.random() * 160;
      sparks.push({ x: cx, y: r.y + r.height * (0.2 + Math.random() * 0.6), vx: Math.cos(a) * s, vy: Math.sin(a) * s - 40, life: 1 });
    }
  }

  // ---- input ----
  onPress(canvas, (x, y) => {
    if (ann.enabled || state === 'ready') return;
    if (state === 'over') { if (performance.now() - overAt > 250) begin(); return; }
    if (state !== 'play' || pausedAt !== null) return;
    const now = clock();
    const p = view.toNorm(x, y);
    const bs = books();
    const idx = bs.findIndex(b => contains(b, p.x, p.y));
    if (idx < 0) return; // taps outside any book do nothing
    const target = notes.find(n => !n.hit && now >= n.lit - 0.08 && now <= n.dead + GRACE);
    if (target && target.book === idx) {
      target.hit = true; score++;
      tone(idx); hitFlash.set(idx, performance.now());
      burst(view.rect(bs[idx]));
    } else gameOver(idx);
  });
  const onKey = (e: KeyboardEvent) => {
    if (ann.enabled) return;
    if ((e.code === 'Space' || e.code === 'Enter') && (state === 'ready' || state === 'over')) {
      if (state === 'over' && performance.now() - overAt < 250) return;
      begin();
    }
  };
  addEventListener('keydown', onKey);

  // ---- UI ----
  const mk = (cls: string, html: string) => { const d = document.createElement('div'); d.className = cls; d.innerHTML = html; stage.appendChild(d); return d; };
  const ui = mk('overlay', `<h2>Piano Tiles</h2><div class="sub">Tap the glowing book before it fades</div><button class="big">Start</button>`);
  (ui.querySelector('button') as HTMLButtonElement).onclick = begin;
  const overUi = mk('overlay', `<h2>Game Over</h2><div class="score" style="font-size:72px;font-weight:800">0</div><div class="best sub"></div><button class="big">Restart</button><div class="sub">or tap anywhere</div>`);
  overUi.hidden = true;
  // restart button: the canvas press handler is below the overlay, so handle here too
  overUi.addEventListener('pointerdown', () => { if (state === 'over' && performance.now() - overAt > 250) begin(); });

  const top = mk('topbar', `<div><button data-a="home">${live ? 'Rescan' : 'Home'}</button></div><div><button data-a="rec">9:16</button><button data-a="edit">Annotate</button></div>`);
  const toggleEdit = editorBar(stage, ann, store, on => { ui.hidden = on || state !== 'ready'; if (on) state = 'ready'; });
  top.querySelectorAll('button').forEach(b => (b as HTMLButtonElement).onclick = () => {
    const a = b.getAttribute('data-a');
    if (a === 'home') { if (live) live.rescan(); else location.hash = ''; }
    if (a === 'rec') document.body.classList.toggle('rec');
    if (a === 'edit') toggleEdit(!ann.enabled);
  });

  // ---- render ----
  function draw() {
    if (!alive) return;
    raf = requestAnimationFrame(draw);
    ({ w: W, h: H } = fitCanvas(canvas, ctx));
    if (!scene) return;
    scene.update();
    if (scene.live && !ann.enabled) view.fit(scene.window(), W, H, 'contain'); else view.contain(W, H);
    const realNow = clock();
    const bs = books();

    // live: if the camera loses the shelf, pause (shift the whole song later) instead of misjudging taps
    if (state === 'count' || state === 'play') {
      if (scene.lost()) { if (pausedAt === null) pausedAt = realNow; }
      else if (pausedAt !== null) {
        const d = realNow - pausedAt;
        notes.forEach(n => { n.lit += d; n.dead += d; }); nextLit += d; t0 += d; pausedAt = null;
      }
    }
    const now = pausedAt ?? realNow;

    // logic: keep 2 notes queued, detect misses
    if ((state === 'count' || state === 'play') && pausedAt === null) {
      while (notes.filter(n => !n.hit && n.lit >= now - 0.001).length < 2) genNote();
      if (state === 'count' && now >= t0 + COUNT_STEP * 3) state = 'play';
      if (state === 'play') {
        const miss = notes.find(n => !n.hit && now > n.dead + GRACE);
        if (miss) gameOver(miss.book);
      }
    }

    ctx.save();
    if (shake > 0) { ctx.translate((Math.random() - 0.5) * 14 * shake, (Math.random() - 0.5) * 14 * shake); shake = Math.max(0, shake - 0.06); }
    scene.draw(ctx, view, W, H);
    ctx.fillStyle = state === 'ready' || state === 'over' ? 'rgba(0,0,0,.45)' : `rgba(0,0,0,${scene.live ? 0.18 : 0.3})`;
    ctx.fillRect(0, 0, W, H);

    // upcoming hint + active glow
    const pending = notes.filter(n => !n.hit && n.dead + GRACE >= now);
    const active = pending.find(n => n.lit <= now);
    const nextN = pending.find(n => n.lit > now);
    if (state === 'play' || state === 'count') {
      if (nextN) {
        const r = view.rect(bs[nextN.book]);
        ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 2; ctx.setLineDash([5, 5]);
        roundRect(ctx, r, 4); ctx.stroke(); ctx.setLineDash([]);
      }
      if (active) {
        const r = view.rect(bs[active.book]);
        const frac = (now - active.lit) / (active.dead - active.lit);
        const pulse = 0.75 + 0.25 * Math.sin(now * 18);
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.shadowColor = '#ffcc55'; ctx.shadowBlur = 28;
        const g = ctx.createLinearGradient(r.x, r.y, r.x, r.y + r.height);
        g.addColorStop(0, `rgba(255,214,110,${0.55 * pulse})`); g.addColorStop(1, `rgba(255,170,60,${0.3 * pulse})`);
        ctx.fillStyle = g; roundRect(ctx, r, 3); ctx.fill();
        ctx.restore();
        ctx.strokeStyle = '#fff3c4'; ctx.lineWidth = 2.5; roundRect(ctx, r, 3); ctx.stroke();
        // shrinking timer bar along the book's bottom edge
        ctx.fillStyle = '#fff'; ctx.fillRect(r.x, r.y + r.height + 4, r.width * (1 - Math.min(1, frac)), 3);
      }
    }
    // hit flash
    for (const [i, t] of hitFlash) {
      const a = 1 - (performance.now() - t) / 380;
      if (a <= 0) { hitFlash.delete(i); continue; }
      const r = view.rect(bs[i]);
      ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = `rgba(160,255,200,${a * 0.7})`;
      roundRect(ctx, r, 3); ctx.fill(); ctx.restore();
    }
    if (state === 'over' && missedBook >= 0 && bs[missedBook]) {
      const r = view.rect(bs[missedBook]);
      ctx.fillStyle = 'rgba(255,40,40,.55)'; roundRect(ctx, r, 3); ctx.fill();
      ctx.strokeStyle = '#ff6b6b'; ctx.lineWidth = 3; roundRect(ctx, r, 3); ctx.stroke();
    }
    // sparks
    const dt = 1 / 60;
    sparks = sparks.filter(s => (s.life -= dt * 1.8) > 0);
    for (const s of sparks) {
      s.x += s.vx * dt; s.y += s.vy * dt; s.vy += 260 * dt;
      ctx.fillStyle = `rgba(255,226,140,${s.life})`; ctx.fillRect(s.x, s.y, 3, 3);
    }
    ann.draw(ctx);
    if (ann.enabled) { ctx.fillStyle = '#fff'; ctx.font = '13px system-ui'; ctx.fillText('Drag over each book spine. Left → right = low → high note.', 12, H - 62); }
    ctx.restore();

    // HUD
    ctx.textAlign = 'center';
    if (state === 'play' || state === 'count') {
      ctx.font = '800 64px system-ui'; ctx.fillStyle = '#fff'; ctx.shadowColor = '#000'; ctx.shadowBlur = 12;
      ctx.fillText(String(score), W / 2, 90); ctx.shadowBlur = 0;
    }
    if (state === 'count') {
      const n = 3 - Math.floor((now - t0) / COUNT_STEP);
      if (n > 0) {
        const f = ((now - t0) % COUNT_STEP) / COUNT_STEP;
        if (lastTick !== n) { lastTick = n; tick(false); }
        ctx.font = `800 ${120 - f * 30}px system-ui`; ctx.fillStyle = `rgba(255,255,255,${1 - f * 0.6})`;
        ctx.shadowColor = '#000'; ctx.shadowBlur = 16; ctx.fillText(String(n), W / 2, H / 2 + 30); ctx.shadowBlur = 0;
      } else if (lastTick !== 0) { lastTick = 0; tick(true); }
    }
    if (pausedAt !== null) {
      ctx.font = '700 20px system-ui'; ctx.fillStyle = '#fff'; ctx.shadowColor = '#000'; ctx.shadowBlur = 10;
      ctx.fillText('Paused — point back at the shelf', W / 2, H - 40); ctx.shadowBlur = 0;
    }
    ctx.textAlign = 'left';
  }
  let lastTick = -1;

  (live ? Promise.resolve(live.scene) : loadImage(config.image).then(photoScene)).then(sc => {
    scene = sc; view = new View(sc.w, sc.h);
    if (live?.audio && live.audio.state === 'running') begin();   // scanned: just start playing
  });
  raf = requestAnimationFrame(draw);

  // test hook (used by automated browser tests)
  (window as any).__piano = { get state() { return state; }, get score() { return score; }, notes: () => notes, books, clock, view: () => view, canvas, get paused() { return pausedAt !== null; } };

  return () => { alive = false; cancelAnimationFrame(raf); removeEventListener('keydown', onKey); if (!live) audio?.close(); document.body.classList.remove('playing', 'rec'); };
}
