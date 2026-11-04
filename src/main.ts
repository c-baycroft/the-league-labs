// Home screen + hash router. Each game exports start(stage) -> dispose.
type Game = { start: (stage: HTMLElement) => () => void };

const app = document.getElementById('app')!;
const games: Record<string, () => Promise<Game>> = {
  piano: () => import('../games/piano-tiles/game'),
  flappy: () => import('../games/flappy-bird/game'),
  scan: () => import('./scan'),
  xr: () => import('../xr/index'),
};
let dispose: (() => void) | null = null;

async function route() {
  dispose?.(); dispose = null;
  app.innerHTML = '';
  document.body.classList.remove('playing');
  const key = location.hash.slice(1).split('?')[0];
  if (key in games) {
    const stage = document.createElement('div');
    stage.className = 'stage';
    app.appendChild(stage);
    try { dispose = (await games[key]()).start(stage); }
    catch (e) { stage.textContent = String(e); console.error(e); }
    return;
  }
  app.innerHTML = `<div class="home"><h1>THE LEAGUE LABS</h1><p>Real environments, real games</p>
    <a href="#scan" style="background:#ffd66e;color:#1a1305;border-color:#ffd66e">Scan a bookshelf<small style="opacity:.75">Point, zoom in — it starts playing</small></a>
    <a href="#xr">Mixed Reality (Quest)<small>Touch the real books · fly the real shelf</small></a>
    <a href="#piano">Piano Tiles<small>Bookshelf Edition</small></a>
    <a href="#flappy">Flappy Bird<small>Bookshelf Edition</small></a></div>`;
}
addEventListener('hashchange', route);
route();

if ('serviceWorker' in navigator && import.meta.env.PROD) navigator.serviceWorker.register('./sw.js').catch(() => {});
