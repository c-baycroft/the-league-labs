// MR Flappy: register the real gap (underside of the shelf above + tops of the books), pinch to flap.
// 2D physics in the vertical plane along the shelf, same rules as the phone game: gravity, flap
// impulse, bounce off real geometry, loop at the end of the gap.
import * as THREE from 'three';
import { Dwell, XRApp, dwellRing, sounds } from './app';

interface R2 { x: number; y: number; w: number; h: number }
const UP = new THREE.Vector3(0, 1, 0);
const BOUNCE = 0.45, DT = 1 / 60;

// same pixel bird as the 2D game
const FRAMES = [
  ['...oooo.....', '..oyyyyo.oo.', '.oyyyyywkwo.', '.oyyyyyywwor', '.oyyyyyyyoo.', '.oyywwyyyyo.', '..oywwwyyo..', '...oyyyoo...', '....oooo....'],
  ['...oooo.....', '..oyyyyo.oo.', '.oyyyyywkwo.', '.oyyyyyywwor', '.ooyyyyyyoo.', '.owwyyyyyyo.', '.owwwyyyyo..', '..oooyyoo...', '....ooo.....'],
].map(f => {
  const c = document.createElement('canvas'); c.width = 12; c.height = 9;
  const g = c.getContext('2d')!;
  const col: Record<string, string> = { o: '#3a2a12', y: '#ffd23f', w: '#fff6d6', r: '#ff8a3d', k: '#111' };
  f.forEach((row, y) => [...row].forEach((ch, x) => { if (col[ch]) { g.fillStyle = col[ch]; g.fillRect(x, y, 1, 1); } }));
  const t = new THREE.CanvasTexture(c); t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; t.colorSpace = THREE.SRGBColorSpace;
  return t;
});

export function runFlappy(app: XRApp) {
  const sfx = sounds(app);
  const dwell = new Dwell(), ring = dwellRing(app.scene);
  let phase: 'ceiling' | 'tops' | 'ready' | 'play' = 'ceiling';
  let ceil: THREE.Vector3 | null = null;
  const tops: THREE.Vector3[] = [];
  const markers: THREE.Mesh[] = [];
  const markerGeo = new THREE.SphereGeometry(0.006, 12, 8);

  // plane frame: origin o, along-shelf dir, normal toward player; 2D coords (x along dir, y = world height)
  let o = new THREE.Vector3(), dir = new THREE.Vector3(1, 0, 0), nrm = new THREE.Vector3(0, 0, 1), depth = 0;
  let solids: R2[] = [], x0 = 0, x1 = 1, R = 0.015, G = 0, FLAP = 0, SPEED = 0;
  let bx = 0, by = 0, vx = 0, vy = 0, t = 0, acc = 0, lastBump = -1, flapT = -1;
  let score = 0, streak = 0, best = 0, laps = 0, passed = 0, steps: number[] = [];
  let bird: THREE.Mesh | null = null;

  const say = () => {
    if (phase === 'ceiling') app.say('Flappy · step 1\nHold a fingertip under the shelf above the gap');
    else if (phase === 'tops') app.say(`Flappy · step 2 · ${tops.length} points\nHold on the book tops along the gap${tops.length >= 3 ? ' · pinch to fly' : ''}`);
    else if (phase === 'ready') app.say('Pinch to flap\nfly through the gap over the books');
    else app.say(`${score}${streak >= 3 ? `  ·  ${streak} clean` : ''}\nPinch to flap · best ${best}`);
  };
  say();

  function mark(p: THREE.Vector3, color: number) {
    const m = new THREE.Mesh(markerGeo, new THREE.MeshBasicMaterial({ color, depthTest: false }));
    m.renderOrder = 8; m.position.copy(p); app.scene.add(m); markers.push(m);
  }

  function build() {
    const a = tops[0], b = tops[tops.length - 1];
    dir = new THREE.Vector3(b.x - a.x, 0, b.z - a.z).normalize();
    nrm = new THREE.Vector3().crossVectors(UP, dir).normalize();
    if (nrm.dot(app.head().pos.sub(a)) < 0) nrm.negate();
    o = new THREE.Vector3(a.x, 0, a.z);
    const pts = tops.map(p => ({ x: p.clone().sub(o).dot(dir), y: p.y, d: p.clone().sub(o).dot(nrm) })).sort((p, q) => p.x - q.x);
    depth = pts.reduce((s, p) => s + p.d, 0) / pts.length + 0.01;   // fly just in front of the spines' top edge
    const cy = ceil!.y;
    const gaps = pts.map(p => cy - p.y).sort((p, q) => p - q);
    const gap = gaps[Math.floor(gaps.length / 2)];
    R = THREE.MathUtils.clamp(gap * 0.12, 0.008, 0.025);
    const s = R / 6;                            // 2D game constants were tuned for R = 6 px
    G = 420 * s; FLAP = 125 * s; SPEED = 50 * s;
    x0 = pts[0].x; x1 = pts[pts.length - 1].x;
    // step skyline: each sample owns the span between midpoints to its neighbours
    solids = [{ x: x0 - 1, y: cy, w: x1 - x0 + 2, h: 1 }];
    steps = [];
    pts.forEach((p, i) => {
      const l = i === 0 ? x0 - 0.05 : (pts[i - 1].x + p.x) / 2, r = i === pts.length - 1 ? x1 + 0.05 : (p.x + pts[i + 1].x) / 2;
      solids.push({ x: l, y: p.y - 1, w: r - l, h: 1 });
      steps.push(r);
    });
    markers.forEach(m => (m.visible = false));
    bird = new THREE.Mesh(new THREE.PlaneGeometry(R * 2.6, R * 1.95), new THREE.MeshBasicMaterial({ map: FRAMES[0], transparent: true, alphaTest: 0.5, side: THREE.DoubleSide }));
    // orient: plane faces the player, bird's beak points along +dir
    const right = new THREE.Vector3().crossVectors(UP, nrm);
    bird.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, UP, nrm));
    if (right.dot(dir) < 0) bird.scale.x = -1;
    app.scene.add(bird);
    reset(); phase = 'ready'; say();
  }

  function reset() {
    bx = x0 + R * 2; by = (ceil!.y + Math.max(...solids.slice(1, 3).map(s => s.y + s.h))) / 2;
    vx = 0; vy = 0; t = 0; acc = 0; score = 0; streak = 0; laps = 0; passed = 0;
  }

  function collide() {
    let hit = false;
    for (const s of solids) {
      const nx = THREE.MathUtils.clamp(bx, s.x, s.x + s.w), ny = THREE.MathUtils.clamp(by, s.y, s.y + s.h);
      let dx = bx - nx, dy = by - ny, d = Math.hypot(dx, dy);
      if (d >= R) continue;
      if (d === 0) {
        const l = bx - s.x, r = s.x + s.w - bx, u = s.y + s.h - by, b = by - s.y, m = Math.min(l, r, u, b);
        dx = m === l ? -1 : m === r ? 1 : 0; dy = m === u ? 1 : m === b ? -1 : 0;
        bx += dx * (m + R); by += dy * (m + R);
      } else { dx /= d; dy /= d; bx += dx * (R - d); by += dy * (R - d); }
      const vn = vx * dx + vy * dy;
      if (vn < 0) { vx -= (1 + BOUNCE) * vn * dx; vy -= (1 + BOUNCE) * vn * dy; }
      hit = true;
    }
    if (hit && t - lastBump > 0.15) { lastBump = t; streak = 0; sfx.bump(); say(); }
  }

  function step() {
    t += DT;
    vy -= G * DT;                                  // world y is up
    vx += (SPEED * Math.min(1.7, 1 + 0.05 * t) - vx) * Math.min(1, 2.5 * DT);
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(vx), Math.abs(vy)) * DT / (R * 0.4)));
    for (let i = 0; i < n; i++) { bx += vx * DT / n; by += vy * DT / n; collide(); }
    const p = steps.filter(r => r < bx - R).length;
    if (p > passed) { score += p - passed; streak += p - passed; passed = p; best = Math.max(best, streak); say(); }
    if (bx > x1) { laps++; passed = 0; bx = x0 + R * 2; sfx.lap(); }   // loop and keep flying
  }

  app.onPinch = () => {
    app.unlockAudio();
    if (phase === 'tops' && tops.length >= 3) { build(); return; }
    if (phase === 'ready') { phase = 'play'; say(); }
    if (phase === 'play') { vy = FLAP; flapT = t; sfx.flap(); }
  };

  app.onFrame = (dt) => {
    const head = app.head().pos;
    if (phase === 'ceiling' || phase === 'tops') {
      const tip = app.tips[0] ?? app.tips[1];
      const p = dwell.update(tip, dt);
      ring.show(tip, dwell.progress, head);
      if (p) {
        if (phase === 'ceiling') { ceil = p; mark(p, 0x4dd2ff); sfx.register(); phase = 'tops'; }
        else {
          const near = tops.findIndex(q => q.distanceTo(p) < 0.025);
          if (near >= 0) { tops.splice(near, 1); app.scene.remove(markers.splice(near + 1, 1)[0]); sfx.remove(); }
          else if (p.y < ceil!.y - 0.02) { tops.push(p); mark(p, 0xffd66e); sfx.register(); }
        }
        say();
      }
      return;
    }
    ring.show(null, 0, head);
    if (phase === 'play') { acc += dt; while (acc >= DT) { acc -= DT; step(); } }
    else by = (ceil!.y + Math.max(...solids.slice(1, 3).map(s => s.y + s.h))) / 2 + Math.sin(performance.now() / 260) * R * 0.6;
    if (bird) {
      bird.position.copy(o).addScaledVector(dir, bx).addScaledVector(nrm, depth); bird.position.y = by;
      (bird.material as THREE.MeshBasicMaterial).map = FRAMES[flapT >= 0 && t - flapT < 0.14 ? 1 : 0];
    }
  };

  (window as any).__xrFlappy = {
    get phase() { return phase; }, get score() { return score; }, get laps() { return laps; },
    get bird() { return { x: bx, y: by, vx, vy, R }; }, solids: () => solids, get ceil() { return ceil?.y; },
  };
}
