// Shared WebXR shell for the Quest mixed-reality games: passthrough session, fingertips (hands or
// controllers), hold-to-register, pinch, a floating instruction panel and simple synth sounds.
// sim=true runs the same code on a desktop with a fake shelf (mouse = fingertip, Space = pinch).
import * as THREE from 'three';

export class XRApp {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(70, 1, 0.01, 20);
  audio: AudioContext | null = null;
  /** fingertip positions this frame (world metres), null when not tracked */
  tips: (THREE.Vector3 | null)[] = [null, null];
  onPinch: (() => void) | null = null;
  onFrame: ((dt: number, t: number) => void) | null = null;
  readonly sim: boolean;
  simTip: THREE.Vector3 | null = null;     // desktop simulator fingertip
  private panel: THREE.Mesh;
  private panelCtx: CanvasRenderingContext2D;
  private panelTex: THREE.CanvasTexture;
  private panelText = '';
  private clock = new THREE.Clock();
  private tmp = new THREE.Vector3();

  constructor(private host: HTMLElement, sim: boolean) {
    this.sim = sim;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(2, devicePixelRatio));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.xr.enabled = true;
    this.renderer.xr.setReferenceSpaceType('local-floor');
    host.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 2.5));
    this.camera.position.set(0, 1.4, 0);

    // pinch / trigger arrives as 'selectstart' on the XR controller objects (hands too on Quest)
    for (let i = 0; i < 2; i++) {
      const c = this.renderer.xr.getController(i);
      c.addEventListener('selectstart', () => this.onPinch?.());
      this.scene.add(c);
      this.scene.add(this.renderer.xr.getHand(i));
      this.scene.add(this.renderer.xr.getControllerGrip(i));
    }

    // floating instruction / score panel
    const cv = document.createElement('canvas'); cv.width = 1024; cv.height = 300;
    this.panelCtx = cv.getContext('2d')!;
    this.panelTex = new THREE.CanvasTexture(cv);
    this.panelTex.colorSpace = THREE.SRGBColorSpace;
    this.panel = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.123), new THREE.MeshBasicMaterial({ map: this.panelTex, transparent: true, depthTest: false }));
    this.panel.renderOrder = 10;
    this.scene.add(this.panel);

    if (sim) this.setupSim();
    const resize = () => {
      const r = host.getBoundingClientRect();
      this.renderer.setSize(r.width, r.height, false);
      this.camera.aspect = r.width / Math.max(1, r.height); this.camera.updateProjectionMatrix();
    };
    addEventListener('resize', resize); resize();
    this.renderer.setAnimationLoop((t) => this.frame(t));
  }

  unlockAudio() {
    try { if (!this.audio) this.audio = new AudioContext(); this.audio.resume(); } catch { /* no audio */ }
  }

  async enterXR() {
    this.unlockAudio();
    const session = await (navigator as any).xr.requestSession('immersive-ar', {
      requiredFeatures: ['local-floor'], optionalFeatures: ['hand-tracking'],
    });
    await this.renderer.xr.setSession(session);
    return session as XRSession;
  }

  say(text: string) {
    if (text === this.panelText) return;
    this.panelText = text;
    const g = this.panelCtx, W = 1024, H = 300;
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(10,10,14,0.78)'; g.beginPath(); g.roundRect(0, 0, W, H, 40); g.fill();
    g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
    const lines = text.split('\n');
    lines.forEach((l, i) => {
      g.font = i === 0 ? 'bold 64px system-ui' : '44px system-ui';
      g.fillStyle = i === 0 ? '#ffd66e' : '#fff';
      g.fillText(l, W / 2, H / 2 + (i - (lines.length - 1) / 2) * 78);
    });
    this.panelTex.needsUpdate = true;
  }

  /** head pose (camera in XR, the fixed desktop camera in sim) */
  head() {
    const cam = this.renderer.xr.isPresenting ? this.renderer.xr.getCamera() : this.camera;
    const pos = new THREE.Vector3(), q = new THREE.Quaternion();
    cam.getWorldPosition(pos); cam.getWorldQuaternion(q);
    return { pos, fwd: new THREE.Vector3(0, 0, -1).applyQuaternion(q) };
  }

  private readTips() {
    if (!this.renderer.xr.isPresenting) { this.tips = [this.simTip?.clone() ?? null, null]; return; }
    for (let i = 0; i < 2; i++) {
      const hand = this.renderer.xr.getHand(i) as any;
      const j = hand.joints?.['index-finger-tip'];
      if (j && j.visible !== false && hand.visible !== false && j.matrixWorld) {
        // joints are only valid while the hand is tracked; jointSpace position is reset to 0 otherwise
        j.getWorldPosition(this.tmp);
        if (this.tmp.lengthSq() > 1e-6) { this.tips[i] = this.tmp.clone(); continue; }
      }
      const grip = this.renderer.xr.getControllerGrip(i);
      if (grip.visible && grip.position.lengthSq() > 1e-6) {
        // controller: a "fingertip" 6 cm in front of the grip
        this.tips[i] = new THREE.Vector3(0, 0, -0.06).applyMatrix4(grip.matrixWorld);
      } else this.tips[i] = null;
    }
  }

  private frame(_t: number) {
    const dt = Math.min(0.05, this.clock.getDelta()), t = this.clock.elapsedTime;
    this.readTips();
    // panel floats ~0.55 m ahead, a little below eye level, and lazily follows the head
    const h = this.head();
    const target = h.pos.clone().add(new THREE.Vector3(h.fwd.x, 0, h.fwd.z).normalize().multiplyScalar(0.55)).add(new THREE.Vector3(0, -0.2, 0));
    this.panel.position.lerp(target, this.panel.position.lengthSq() === 0 ? 1 : Math.min(1, dt * 2.5));
    this.panel.lookAt(h.pos);
    this.onFrame?.(dt, t);
    this.renderer.render(this.scene, this.camera);
  }

  // ---------- desktop simulator ----------
  simShelf: THREE.Group | null = null;
  private setupSim() {
    this.renderer.setClearColor(0x1a1612, 1);
    const g = new THREE.Group();
    const wood = new THREE.MeshLambertMaterial({ color: 0x8a5a2b });
    const z = -0.55;
    const board = (y: number) => { const m = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.025, 0.25), wood); m.position.set(0, y, z - 0.1); g.add(m); };
    board(1.0); board(1.42);
    const back = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.45, 0.01), new THREE.MeshLambertMaterial({ color: 0x15120f })); back.position.set(0, 1.21, z - 0.22); g.add(back);
    let x = -0.45, i = 0;
    const cols = [0xc8553d, 0x2f6f8f, 0xe8dcc0, 0x5a7d4f, 0x7a3b5e, 0xd9a441, 0x40434a, 0xb7b0a2];
    while (x < 0.45) {
      const w = 0.022 + ((i * 37) % 17) / 1000, hgt = 0.2 + ((i * 53) % 9) / 100;
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, hgt, 0.18), new THREE.MeshLambertMaterial({ color: cols[i % cols.length] }));
      b.position.set(x + w / 2, 1.0125 + hgt / 2, z - 0.1); g.add(b);
      x += w + 0.001; i++;
    }
    this.scene.add(g); this.simShelf = g;
    this.camera.position.set(0, 1.3, 0.05); this.camera.lookAt(0, 1.2, z);
    // mouse = fingertip on the front face of the shelf while the button is held
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -(z - 0.01));
    const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
    let down = false;
    const move = (e: PointerEvent) => {
      const r = this.renderer.domElement.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, this.camera);
      const p = new THREE.Vector3();
      this.simTip = down && ray.ray.intersectPlane(plane, p) ? p : null;
    };
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', e => { down = true; move(e); });
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', () => { down = false; this.simTip = null; });
    addEventListener('keydown', e => { if (e.code === 'Space') { e.preventDefault(); this.onPinch?.(); } });
  }

  dispose() {
    this.renderer.setAnimationLoop(null);
    this.renderer.xr.getSession()?.end();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.audio?.close();
  }
}

/** Hold a fingertip still for HOLD seconds to register a point. Returns the point once; then the finger must move away. */
export class Dwell {
  progress = 0;
  private anchor: THREE.Vector3 | null = null;
  private armed = true;
  private last: THREE.Vector3 | null = null;
  static HOLD = 0.5;

  update(p: THREE.Vector3 | null, dt: number): THREE.Vector3 | null {
    if (!p) { this.anchor = null; this.progress = 0; this.armed = true; this.last = null; return null; }
    if (!this.armed) {
      if (this.last && p.distanceTo(this.last) > 0.04) this.armed = true;
      return null;
    }
    if (!this.anchor || p.distanceTo(this.anchor) > 0.012) { this.anchor = p.clone(); this.progress = 0; return null; }
    this.progress += dt / Dwell.HOLD;
    if (this.progress >= 1) {
      this.progress = 0; this.armed = false; this.last = this.anchor.clone(); this.anchor = null;
      return this.last.clone();
    }
    return null;
  }
}

/** Ring that fills while a dwell is in progress. */
export function dwellRing(scene: THREE.Scene) {
  const geo = new THREE.RingGeometry(0.012, 0.016, 32, 1, 0, Math.PI * 2);
  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xffd66e, transparent: true, depthTest: false, side: THREE.DoubleSide }));
  m.renderOrder = 9; scene.add(m);
  return {
    show(p: THREE.Vector3 | null, progress: number, head: THREE.Vector3) {
      m.visible = !!p && progress > 0.05;
      if (!p) return;
      m.position.copy(p); m.lookAt(head);
      m.geometry.dispose();
      m.geometry = new THREE.RingGeometry(0.012, 0.016, 32, 1, Math.PI / 2, -Math.PI * 2 * Math.min(1, progress));
    },
  };
}

/** Piano-ish tone (pentatonic by index) and a few effects. */
export function sounds(app: XRApp) {
  const PENT = [0, 2, 4, 7, 9];
  const env = (f: number, dur: number, vol: number, type: OscillatorType, f1?: number) => {
    const a = app.audio; if (!a) return;
    const t = a.currentTime, o = a.createOscillator(), g = a.createGain();
    o.type = type; o.frequency.setValueAtTime(f, t); if (f1) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(a.destination); o.start(t); o.stop(t + dur + 0.02);
  };
  return {
    note(i: number, vol = 0.45) {
      const f = 261.63 * Math.pow(2, (PENT[i % 5] + 12 * Math.floor(i / 5)) / 12);
      env(f, 0.9, vol, 'triangle'); env(f * 2, 0.6, vol * 0.3, 'sine');
    },
    tick() { env(880, 0.08, 0.2, 'sine'); },
    register() { env(660, 0.1, 0.25, 'sine', 990); },
    remove() { env(500, 0.12, 0.2, 'sine', 300); },
    flap() { env(420, 0.09, 0.12, 'square', 760); },
    bump() { env(180, 0.12, 0.15, 'square', 90); },
    lap() { env(520, 0.35, 0.2, 'triangle', 1040); },
  };
}
