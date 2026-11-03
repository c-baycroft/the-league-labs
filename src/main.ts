// Home screen + hash router. Each game exports start(stage) -> dispose.
type Game = { start: (stage: HTMLElement) => () => void };

const app = document.getElementById('app')!;
const games: Record<string, () => Promise<Game>> = {
  piano: () => import('../games/piano-tiles/game'),
  flappy: () => import('../games/flappy-bird/game'),
};
let dispose: (() => void) | null = null;

async function route() {
  dispose?.(); dispose = null;
  app.innerHTML = '';
  document.body.classList.remove('playing');
  const key = location.hash.slice(1);
  if (key in games) {
    const stage = document.createElement('div');
    stage.className = 'stage';
    app.appendChild(stage);
    try { dispose = (await games[key]()).start(stage); }
    catch (e) { stage.textContent = String(e); console.error(e); }
    return;
  }
  app.innerHTML = `<div class="home"><h1>THE LEAGUE LABS</h1><p>Real environments, real games</p>
    <a href="#piano">Piano Tiles<small>Bookshelf Edition</small></a>
    <a href="#flappy">Flappy Bird<small>Bookshelf Edition</small></a></div>`;
}
addEventListener('hashchange', route);
route();
