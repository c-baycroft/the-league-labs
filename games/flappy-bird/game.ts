import config from './config.json';
import { Region, Rect, View, circleHitsRect, clamp, contains } from '../../shared/geometry';
import { Live, drawBackdrop, fitCanvas, loadImage } from '../../shared/image';
import { Annotator, editorBar, loadSaved, onPress } from '../../shared/input';

const STORE = 'league.flappy.regions';
const BEST = 'league.flappy.best';
const DT = 1 / 60;            // fixed physics step

// 12x9 pixel-art bird, two wing frames. . = empty, o outline, y body, w white, r beak, k eye
const FRAMES = [
  ['...oooo.....', '..oyyyyo.oo.', '.oyyyyywkwo.', '.oyyyyyywwor', '.oyyyyyyyoo.', '.oyywwyyyyo.', '..oywwwyyo..', '...oyyyoo...', '....oooo....'],
  ['...oooo.....', '..oyyyyo.oo.', '.oyyyyywkwo.', '.oyyyyyywwor', '.ooyyyyyyoo.', '.owwyyyyyyo.', '.owwwyyyyo..', '..oooyyoo...', '....ooo.....'],
].map(f => {
  const c = document.createElement('canvas'); c.width = 12; c.height = 9;
  const g = c.getContext('2d')!;
  const col: Record<string, string> = { o: '#3a2a12', y: '#ffd23f', w: '#fff6d6', r: '#ff8a3d', k: '#111' };
  f.forEach((row, y) => [...row].forEach((ch, x) => { if (col[ch]) { g.fillStyle = col[ch]; g.fillRect(x, y, 1, 1); } }));
  return c;
});

interface P { x: number; y: number; vx: number; vy: number; life: number; c: string; s: number }

export function start(stage: HTMLElement, live?: Live) {
  const K = live?.scale ?? 1;   // physics scale: 1 for the library photo
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  stage.appendChild(canvas);

  let img: HTMLImageElement, view: View, W = 1, H = 1;
  let state: 'ready' | 'play' | 'dead' | 'won' = 'ready';
  let raf = 0, alive = true, last = 0, acc = 0, audio: AudioContext | null = null;

  const store = live ? STORE + '.live' : STORE;
  const saved = live ? null : loadSaved(STORE);
  const ann = new Annotator(canvas, () => view, [
    { kind: 'solid', color: '#ff4d4d' }, { kind: 'nav', color: '#4dd2ff' },
    { kind: 'start', color: '#6bff6b', point: true }, { kind: 'goal', color: '#ffd66e' },
  ], live ? live.regions : (saved ?? (config.regions as Region[])));

  // solids / goal / start converted to IMAGE PIXELS once per frame source of truth (ann.regions may be edited)
  let solids: Rect[] = [], goal: Rect | null = null, startPt = { x: 100, y: 68 }, scorers: Rect[] = [];
  function rebuild() {
    const iw = img.naturalWidth, ih = img.naturalHeight;
    const px = (r: Rect): Rect => ({ x: r.x * iw, y: r.y * ih, width: r.width * iw, height: r.height * ih });
    const rs = ann.regions;
    solids = rs.filter(r => r.type === 'solid').map(px);
    scorers = ann.regions.filter(r => r.type === 'solid' && r.id.startsWith('book')).map(px);   // book spines
    const g = rs.find(r => r.type === 'goal'); goal = g ? px(g) : null;
    const s = rs.find(r => r.type === 'start'); if (s) startPt = { x: s.x * iw, y: s.y * ih };
  }

  // ---- bird state (image pixels) ----
  const R = config.birdRadius * K;
  let bx = 0, by = 0, vy = 0, t = 0, score = 0, best = +(localStorage.getItem(BEST) ?? 0);
  let flapT = -1, dieAt = 0, shake = 0, parts: P[] = [];

  function reset() {
    rebuild();
    bx = startPt.x; by = startPt.y; vy = 0; t = 0; score = 0; acc = 0; parts = []; flapT = -1;
  }
  const speedNow = () => config.speed * K * Math.min(config.maxSpeedMul, 1 + config.speedRamp * t);

  function beep(f0: number, f1: number, dur: number, type: OscillatorType = 'square', vol = 0.12) {
    if (!audio) return;
    const a = audio.currentTime, o = audio.createOscillator(), g = audio.createGain();
    o.type = type; o.frequency.setValueAtTime(f0, a); o.frequency.exponentialRampToValueAtTime(f1, a + dur);
    g.gain.setValueAtTime(vol, a); g.gain.exponentialRampToValueAtTime(0.0001, a + dur);
    o.connect(g); g.connect(audio.destination); o.start(a); o.stop(a + dur + 0.02);
  }

  function puff(n: number, c: string, spd: number, up = false) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = Math.random() * spd;
      parts.push({ x: bx, y: by, vx: Math.cos(a) * s - (up ? 20 : 0), vy: Math.sin(a) * s + (up ? 25 : 0), life: 1, c, s: 0.8 + Math.random() * 1.2 });
    }
  }

  function flap() {
    if (state === 'dead' || state === 'won') {
      if (performance.now() - dieAt > 300) {
        reset(); state = 'play'; vy = -config.flap * K; beep(500, 800, .1);
        overUi.hidden = true; document.body.classList.add('playing');
      }
      return;
    }
    if (!audio) audio = live?.audio ?? new (window.AudioContext || (window as any).webkitAudioContext)();
    audio.resume();
    if (state === 'ready') { state = 'play'; ui.hidden = true; document.body.classList.add('playing'); }
    vy = -config.flap * K; flapT = t; beep(420, 760, 0.09);
    for (let i = 0; i < 3; i++) parts.push({ x: bx - 3, y: by + 2, vx: -15 - Math.random() * 20, vy: 10 + Math.random() * 25, life: 1, c: '#fff6d6', s: 1 });
  }

  function die() {
    state = 'dead'; dieAt = performance.now(); shake = 1;
    document.body.classList.remove('playing');
    puff(30, '#ffd23f', 110); puff(12, '#fff', 80);
    beep(220, 50, 0.4, 'sawtooth', 0.2);
    if (score > best) { best = score; localStorage.setItem(BEST, String(best)); }
    overUi.querySelector('h2')!.textContent = 'Crashed';
    overUi.querySelector('.score')!.textContent = String(score);
    overUi.querySelector('.best')!.textContent = `Best ${best}`;
    overUi.hidden = false;
  }
  function win() {
    state = 'won'; dieAt = performance.now();
    document.body.classList.remove('playing');
    beep(520, 1040, 0.5, 'triangle', 0.25);
    puff(40, '#9dffb0', 120);
    if (score > best) { best = score; localStorage.setItem(BEST, String(best)); }
    overUi.querySelector('h2')!.textContent = 'You made it!';
    overUi.querySelector('.score')!.textContent = String(score);
    overUi.querySelector('.best')!.textContent = `Best ${best}`;
    overUi.hidden = false;
  }

  /** One fixed 60 Hz step. Movement is sub-stepped so the bird can never skip over a thin solid. */
  function step() {
    t += DT;
    vy += config.gravity * K * DT;
    const vx = speedNow();
    const dx = vx * DT, dy = vy * DT;
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / (R * 0.4)));
    for (let i = 0; i < n; i++) {
      bx += dx / n; by += dy / n;
      if (by - R < 0 || by + R > img.naturalHeight || solids.some(s => circleHitsRect(bx, by, R, s))) return die();
      if (goal && contains(goal, bx, by)) return win();
    }
    score = scorers.filter(s => s.x + s.width < bx - R).length;
  }

  // ---- input ----
  onPress(canvas, () => { if (!ann.enabled) flap(); });
  const onKey = (e: KeyboardEvent) => { if (!ann.enabled && (e.code === 'Space' || e.code === 'ArrowUp')) { e.preventDefault(); flap(); } };
  addEventListener('keydown', onKey);

  // ---- UI ----
  const mk = (cls: string, html: string) => { const d = document.createElement('div'); d.className = cls; d.innerHTML = html; stage.appendChild(d); return d; };
  const ui = mk('overlay passive', `<h2>Flappy Bird</h2><div class="sub">Tap to flap · fly the shelf gap to the green goal</div><div class="sub">Tap to start</div>`);
  const overUi = mk('overlay passive', `<h2></h2><div class="score" style="font-size:72px;font-weight:800">0</div><div class="best sub"></div><div class="sub">Tap to restart</div>`);
  overUi.hidden = true;
  const top = mk('topbar', `<div><button data-a="home">${live ? 'Rescan' : 'Home'}</button></div><div><button data-a="rec">9:16</button><button data-a="edit">Annotate</button></div>`);
  const toggleEdit = editorBar(stage, ann, store, on => {
    ui.hidden = on || state !== 'ready';
    if (!on && img) { reset(); state = 'ready'; ui.hidden = false; overUi.hidden = true; }
  });
  top.querySelectorAll('button').forEach(b => (b as HTMLButtonElement).onclick = () => {
    const a = b.getAttribute('data-a');
    if (a === 'home') { if (live) live.rescan(); else location.hash = ''; }
    if (a === 'rec') document.body.classList.toggle('rec');
    if (a === 'edit') toggleEdit(!ann.enabled);
  });

  // ---- render ----
  function frame(ts: number) {
    if (!alive) return;
    raf = requestAnimationFrame(frame);
    ({ w: W, h: H } = fitCanvas(canvas, ctx));
    if (!img) return;
    const dtReal = Math.min(0.25, (ts - (last || ts)) / 1000); last = ts;
    if (state === 'play' && !ann.enabled) { acc += dtReal; while (acc >= DT && state === 'play') { acc -= DT; step(); } }
    else if (state === 'ready') { by = startPt.y + Math.sin(ts / 260) * 4 * K; }

    // camera: bird sits at ~30% of the screen, editing shows whole photo
    if (ann.enabled) view.contain(W, H);
    else view.cover(W, H, bx - view.visibleImageWidth(W) * 0.3);

    ctx.save();
    if (shake > 0) { ctx.translate((Math.random() - 0.5) * 12 * shake, (Math.random() - 0.5) * 12 * shake); shake = Math.max(0, shake - 0.05); }
    drawBackdrop(ctx, img, W, H);
    ctx.drawImage(img, view.ox, view.oy, img.naturalWidth * view.scale, img.naturalHeight * view.scale);

    // goal marker (a real gap in the photo, so it's drawn as a soft glow, not a fake object)
    if (goal && !ann.enabled) {
      const x = view.px(goal.x), y = view.py(goal.y), w = goal.width * view.scale, h = goal.height * view.scale;
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createLinearGradient(x, 0, x + w, 0); g.addColorStop(0, 'rgba(90,255,150,0)'); g.addColorStop(1, 'rgba(90,255,150,.45)');
      ctx.fillStyle = g; ctx.fillRect(x, y, w, h); ctx.restore();
    }

    // particles
    parts = parts.filter(p => (p.life -= DT * 1.6) > 0);
    for (const p of parts) {
      p.x += p.vx * DT; p.y += p.vy * DT; p.vy += 120 * DT;
      ctx.globalAlpha = clamp(p.life, 0, 1); ctx.fillStyle = p.c;
      ctx.fillRect(view.px(p.x), view.py(p.y), p.s * K * view.scale, p.s * K * view.scale);
    }
    ctx.globalAlpha = 1;

    // bird (hidden after crash; hitbox is the circle of radius R drawn faintly while annotating)
    if (state !== 'dead') {
      const sw = R * 2.6 * view.scale, sh = sw * 9 / 12;
      const f = FRAMES[flapT >= 0 && t - flapT < 0.14 ? 1 : 0];
      ctx.save(); ctx.translate(view.px(bx), view.py(by)); ctx.rotate(clamp(vy / 260, -0.5, 0.9));
      ctx.imageSmoothingEnabled = false; ctx.drawImage(f, -sw / 2, -sh / 2, sw, sh); ctx.restore();
    }
    ann.draw(ctx);
    ctx.restore();

    ctx.textAlign = 'center';
    if (state === 'play' || state === 'ready') {
      ctx.font = '800 64px system-ui'; ctx.fillStyle = '#fff'; ctx.shadowColor = '#000'; ctx.shadowBlur = 12;
      ctx.fillText(String(score), W / 2, 90); ctx.shadowBlur = 0;
    }
    ctx.textAlign = 'left';
  }

  (live ? Promise.resolve(live.image) : loadImage(config.image)).then(i => { img = i; view = new View(i.naturalWidth, i.naturalHeight); reset(); });
  raf = requestAnimationFrame(frame);

  (window as any).__flappy = {
    get state() { return state; }, get score() { return score; }, get bird() { return { x: bx, y: by, vy, t }; },
    solids: () => solids, goal: () => goal, flap, canvas, view: () => view, setBird: (x: number, y: number) => { bx = x; by = y; },
  };

  return () => { alive = false; cancelAnimationFrame(raf); removeEventListener('keydown', onKey); if (!live) audio?.close(); document.body.classList.remove('playing', 'rec'); };
}
