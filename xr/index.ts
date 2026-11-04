// #xr: launcher page for the Quest mixed-reality games. #xr?sim=1 runs a desktop simulator.
import { XRApp } from './app';
import { runPiano } from './piano';
import { runFlappy } from './flappy';

export function start(stage: HTMLElement) {
  const sim = new URLSearchParams(location.hash.split('?')[1] ?? '').get('sim') === '1';
  let app: XRApp | null = null;
  const ui = document.createElement('div');
  ui.className = 'overlay';
  ui.innerHTML = `<h2>Mixed Reality</h2>
    <div class="sub" style="max-width:420px">Put on your Quest, then pick a game. You'll register the real shelf by holding a fingertip on it, then play.</div>
    <div style="display:flex;gap:10px"><button class="big" data-g="piano">Piano</button><button class="big" data-g="flappy">Flappy</button></div>
    <div class="sub msg"></div>
    <button data-a="home">Home</button>`;
  stage.appendChild(ui);
  const msg = ui.querySelector('.msg') as HTMLDivElement;

  const xr = (navigator as any).xr;
  if (!sim && !xr) msg.textContent = 'Open this page in the Quest Browser (WebXR not available here).';
  else if (!sim) xr.isSessionSupported('immersive-ar').then((ok: boolean) => { if (!ok) msg.textContent = 'This browser can’t do passthrough mixed reality. Use the Quest Browser.'; });

  ui.querySelectorAll('button').forEach(b => (b as HTMLButtonElement).onclick = async () => {
    if (b.getAttribute('data-a') === 'home') { location.hash = ''; return; }
    const game = b.getAttribute('data-g');
    app?.dispose();
    app = new XRApp(stage, sim);
    if (game === 'piano') runPiano(app); else runFlappy(app);
    if (sim) { app.unlockAudio(); ui.hidden = true; (window as any).__xr = app; return; }
    try {
      const session = await app.enterXR();
      ui.hidden = true;
      session.addEventListener('end', () => { app?.dispose(); app = null; ui.hidden = false; });
    } catch (e) {
      msg.textContent = 'Couldn’t start mixed reality: ' + (e as Error).message;
      app.dispose(); app = null;
    }
  });

  return () => { app?.dispose(); ui.remove(); };
}
