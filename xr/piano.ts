// MR Piano: hold a fingertip on each real book to make it a key, pinch to play.
// Free-flowing: every book plays; lit books are the beat (hits build a combo and speed up).
import * as THREE from 'three';
import { Dwell, XRApp, dwellRing, sounds } from './app';

interface Key { p: THREE.Vector3; marker: THREE.Mesh; face?: THREE.Mesh; c?: THREE.Vector3; w?: number }

const UP = new THREE.Vector3(0, 1, 0);
const KEY_DOWN = 0.11, KEY_UP = 0.08;       // key face extends this far below / above the touch point
const FRONT = 0.06, BACK = 0.05;            // touch volume in front of / into the spine

export function runPiano(app: XRApp) {
  const sfx = sounds(app);
  const dwell = new Dwell(), ring = dwellRing(app.scene);
  const keys: Key[] = [];
  let phase: 'register' | 'play' = 'register';
  let dir = new THREE.Vector3(1, 0, 0), nrm = new THREE.Vector3(0, 0, 1);
  const markerGeo = new THREE.SphereGeometry(0.006, 12, 8);

  // ---- free-flow state ----
  const START_IV = 0.95, MIN_IV = 0.32;
  let iv = START_IV, nextLit = 0, lit = -1, litUntil = 0, last = -1, score = 0, combo = 0, best = 0;
  const inside = [false, false];
  const flashes = new Map<number, { t: number; color: number }>();

  const say = () => {
    if (phase === 'register') app.say(`Piano · ${keys.length} keys\nHold a fingertip on each book${keys.length >= 4 ? ' · pinch to play' : ''}`);
    else app.say(`${score}${combo >= 3 ? `  ·  ${combo} in a row` : ''}\nTouch the glowing book · best ${best}`);
  };
  say();

  function addOrRemove(p: THREE.Vector3) {
    const near = keys.findIndex(k => k.p.distanceTo(p) < 0.03);
    if (near >= 0) { app.scene.remove(keys[near].marker); keys.splice(near, 1); sfx.remove(); say(); return; }
    const marker = new THREE.Mesh(markerGeo, new THREE.MeshBasicMaterial({ color: 0xffd66e, depthTest: false }));
    marker.renderOrder = 8; marker.position.copy(p); app.scene.add(marker);
    keys.push({ p: p.clone(), marker }); sfx.register(); say();
  }

  function build() {
    // shelf direction = first -> last key (horizontal); keys ordered along it; normal faces the player
    const a = keys[0].p, b = keys[keys.length - 1].p;
    dir = new THREE.Vector3(b.x - a.x, 0, b.z - a.z).normalize();
    nrm = new THREE.Vector3().crossVectors(UP, dir).normalize();
    const head = app.head().pos;
    if (nrm.dot(head.clone().sub(a)) < 0) nrm.negate();
    keys.sort((k1, k2) => k1.p.clone().sub(a).dot(dir) - k2.p.clone().sub(a).dot(dir));
    const u = keys.map(k => k.p.clone().sub(a).dot(dir));
    keys.forEach((k, i) => {
      const gl = i > 0 ? u[i] - u[i - 1] : u[1] - u[0], gr = i < keys.length - 1 ? u[i + 1] - u[i] : gl;
      k.w = THREE.MathUtils.clamp(Math.min(gl, gr) * 0.9, 0.012, 0.08);
      k.c = k.p.clone();
      const geo = new THREE.PlaneGeometry(k.w, KEY_DOWN + KEY_UP);
      const face = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xffd66e, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
      face.position.copy(k.p).addScaledVector(nrm, 0.004).addScaledVector(UP, (KEY_UP - KEY_DOWN) / 2);
      face.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(UP, nrm), UP, nrm));
      app.scene.add(face); k.face = face;
      k.marker.visible = false;
    });
    phase = 'play'; nextLit = performance.now() / 1000 + 1.0; say();
  }

  function insideKey(k: Key, p: THREE.Vector3) {
    const d = p.clone().sub(k.c!);
    const along = d.dot(dir), up = d.dot(UP), out = d.dot(nrm);
    return Math.abs(along) <= k.w! / 2 && up >= -KEY_DOWN && up <= KEY_UP && out <= FRONT && out >= -BACK;
  }

  function touch(i: number) {
    const now = performance.now() / 1000;
    if (i === lit && now <= litUntil + 0.08) {
      score++; combo++; best = Math.max(best, combo);
      iv = Math.max(MIN_IV, iv * 0.965);
      sfx.note(i); flashes.set(i, { t: now, color: 0x9dffb0 });
      lit = -1;
    } else sfx.note(i, 0.25);
    say();
  }

  app.onPinch = () => {
    app.unlockAudio();
    if (phase === 'register' && keys.length >= 4) build();
  };

  app.onFrame = (dt) => {
    const head = app.head().pos;
    if (phase === 'register') {
      const tip = app.tips[0] ?? app.tips[1];
      const p = dwell.update(tip, dt);
      ring.show(tip, dwell.progress, head);
      if (p) addOrRemove(p);
      return;
    }
    ring.show(null, 0, head);
    const now = performance.now() / 1000;
    // the beat: light a book, give it iv seconds
    if (lit >= 0 && now > litUntil + 0.08) {       // missed: keep flowing, ease the tempo
      combo = 0; iv = Math.min(START_IV, iv * 1.12); flashes.set(lit, { t: now, color: 0xff5a5a }); lit = -1; say();
    }
    if (lit < 0 && now >= nextLit) {
      let n: number;
      do { n = last < 0 ? Math.floor(keys.length / 2) : THREE.MathUtils.clamp(last + Math.round((Math.random() - 0.5) * 6), 0, keys.length - 1); } while (n === last && keys.length > 1);
      lit = n; last = n; litUntil = now + iv; nextLit = litUntil + 0.05;
    }
    // fingertips entering a key volume = a press
    app.tips.forEach((tip, h) => {
      const k = tip ? keys.findIndex(k => insideKey(k, tip)) : -1;
      const was = inside[h];
      inside[h] = k >= 0;
      if (k >= 0 && !was) touch(k);
    });
    // visuals
    keys.forEach((k, i) => {
      const m = k.face!.material as THREE.MeshBasicMaterial;
      const f = flashes.get(i);
      if (f && now - f.t < 0.35) { m.color.setHex(f.color); m.opacity = 0.7 * (1 - (now - f.t) / 0.35); }
      else if (i === lit) { m.color.setHex(0xffd66e); m.opacity = 0.45 + 0.25 * Math.sin(now * 16); }
      else { m.color.setHex(0xffffff); m.opacity = 0.06; }
    });
  };

  (window as any).__xrPiano = { get phase() { return phase; }, get score() { return score; }, get combo() { return combo; }, get lit() { return lit; }, keys: () => keys, insideKey };
}
