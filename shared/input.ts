import { Region, View } from './geometry';

/** Pointer position in canvas CSS pixels (works for mouse + touch, any layout). */
export function onPress(canvas: HTMLCanvasElement, fn: (x: number, y: number, e: PointerEvent) => void) {
  const h = (e: PointerEvent) => {
    if (e.button > 0) return;
    const r = canvas.getBoundingClientRect();
    fn(e.clientX - r.left, e.clientY - r.top, e);
  };
  canvas.addEventListener('pointerdown', h);
  return () => canvas.removeEventListener('pointerdown', h);
}

export interface Tool { kind: string; color: string; point?: boolean }

/** Draw rectangles (or place single points) over the photo; stores normalized regions. */
export class Annotator {
  enabled = false;
  tool: Tool;
  private drag: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private n = 1;

  constructor(
    private canvas: HTMLCanvasElement,
    private getView: () => View,
    public tools: Tool[],
    public regions: Region[],
  ) {
    this.tool = tools[0];
    this.n = regions.length + 1;
    const pos = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      return this.getView().toNorm(e.clientX - r.left, e.clientY - r.top);
    };
    canvas.addEventListener('pointerdown', e => {
      if (!this.enabled) return;
      const p = pos(e);
      if (this.tool.point) {
        this.regions = this.regions.filter(r => r.type !== this.tool.kind);
        this.regions.push({ id: this.tool.kind, type: this.tool.kind, x: p.x, y: p.y, width: 0, height: 0 });
        return;
      }
      canvas.setPointerCapture(e.pointerId);
      this.drag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    });
    canvas.addEventListener('pointermove', e => {
      if (!this.enabled || !this.drag) return;
      const p = pos(e); this.drag.x1 = p.x; this.drag.y1 = p.y;
    });
    canvas.addEventListener('pointerup', () => {
      if (!this.enabled || !this.drag) return;
      const d = this.drag; this.drag = null;
      const x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1);
      const width = Math.abs(d.x1 - d.x0), height = Math.abs(d.y1 - d.y0);
      if (width < 0.003 || height < 0.003) return;
      const type = this.tool.kind;
      this.regions.push({ id: `${type}-${this.n++}`, type, x, y, width, height });
    });
  }

  undo() { this.regions.pop(); }
  clear() { this.regions = []; this.n = 1; }
  json() { return JSON.stringify(this.regions.map(r => ({ ...r, x: +r.x.toFixed(4), y: +r.y.toFixed(4), width: +r.width.toFixed(4), height: +r.height.toFixed(4) })), null, 1); }

  draw(ctx: CanvasRenderingContext2D) {
    if (!this.enabled) return;
    const v = this.getView();
    const colorOf = (k: string) => this.tools.find(t => t.kind === k)?.color ?? '#fff';
    ctx.save();
    ctx.lineWidth = 2; ctx.font = '12px system-ui'; ctx.textAlign = 'left';
    for (const r of this.regions) {
      const c = colorOf(r.type);
      ctx.strokeStyle = c; ctx.fillStyle = c + '33';
      if (r.width === 0) {
        ctx.beginPath(); ctx.arc(v.sx(r.x), v.sy(r.y), 8, 0, 7); ctx.fill(); ctx.stroke();
        ctx.fillStyle = c; ctx.fillText(r.type, v.sx(r.x) + 12, v.sy(r.y) + 4);
      } else {
        const s = v.rect(r); ctx.fillRect(s.x, s.y, s.width, s.height); ctx.strokeRect(s.x, s.y, s.width, s.height);
      }
    }
    if (this.drag) {
      const d = this.drag, c = this.tool.color;
      const a = v.sx(Math.min(d.x0, d.x1)), b = v.sy(Math.min(d.y0, d.y1));
      ctx.strokeStyle = c; ctx.setLineDash([6, 4]);
      ctx.strokeRect(a, b, v.sx(Math.max(d.x0, d.x1)) - a, v.sy(Math.max(d.y0, d.y1)) - b);
    }
    ctx.restore();
  }
}

/** Small toolbar for annotation mode. Returns a toggle function. */
export function editorBar(stage: HTMLElement, ann: Annotator, storageKey: string, onToggle: (on: boolean) => void) {
  const bar = document.createElement('div');
  bar.className = 'editbar'; bar.hidden = true;
  const btn = (label: string, fn: () => void, extra = '') => {
    const b = document.createElement('button'); b.textContent = label; b.className = extra; b.onclick = fn; bar.appendChild(b); return b;
  };
  const toolBtns = ann.tools.map(t => btn(t.kind, () => { ann.tool = t; sync(); }));
  const sync = () => toolBtns.forEach((b, i) => b.classList.toggle('on', ann.tools[i] === ann.tool));
  sync();
  btn('Undo', () => ann.undo());
  btn('Clear', () => { if (confirm('Clear all regions?')) ann.clear(); });
  btn('Save', () => { localStorage.setItem(storageKey, ann.json()); flash('Saved'); });
  btn('Copy JSON', () => { navigator.clipboard?.writeText(ann.json()); flash('Copied'); });
  btn('Reset', () => { localStorage.removeItem(storageKey); location.reload(); });
  btn('Done', () => toggle(false), 'primary');
  const note = document.createElement('span'); note.className = 'note'; bar.appendChild(note);
  const flash = (t: string) => { note.textContent = t; setTimeout(() => (note.textContent = ''), 1200); };
  stage.appendChild(bar);
  function toggle(on: boolean) { ann.enabled = on; bar.hidden = !on; onToggle(on); }
  return toggle;
}

export function loadSaved(key: string): Region[] | null {
  try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : null; } catch { return null; }
}
