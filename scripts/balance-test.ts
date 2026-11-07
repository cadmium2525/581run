// 簡易ボットで難易度を確認する（npm run balance）
import { Game, NState, COURSE } from '../src/game';
function bot(g: Game, smart: boolean, spam = false) {
  const p = g.player;
  let best = 0, bestScore = -1e9;
  for (const cand of [-1, -0.5, 0, 0.5, 1]) {
    const tx = p.x + cand * 1.2;
    let score = -Math.abs(cand) * 0.2;
    for (const n of g.npcs) {
      if (!n.active) continue;
      const dz = n.z - p.z; if (dz < -0.3 || dz > 3.5) continue;
      const dx = Math.abs(n.x - tx);
      if (dx < 0.7) score -= (n.state === NState.Fallen ? 5 : 2) / (0.5 + dz);
    }
    if (score > bestScore) { bestScore = score; best = cand; }
  }
  let hazard = false;
  for (const n of g.npcs) if (n.active && n.state === NState.Fallen && n.z - p.z > 0.3 && n.z - p.z < 1.2 && Math.abs(n.x - p.x) < 0.6) hazard = true;
  if (spam) return { steer: best === 0 ? (g.steps % 120 < 60 ? 0.6 : -0.6) : best, step: true, dash: p.stamina > 0.3 };
  return { steer: smart ? best : (Math.random() - 0.5), step: smart && hazard, dash: smart && p.stamina > 0.5 };
}
for (const [name, smart, spam] of [['smart', true, false], ['spam', true, true], ['random', false, false]] as const) {
  let clears = 0, tsum = 0, falls = 0, maxActive = 0; const R = 40;
  const t0 = Date.now();
  for (let s = 1; s <= R; s++) {
    const g = new Game(s * 7919); g.start();
    while (!g.finished && g.time < 60) {
      g.update(bot(g, smart, spam));
      maxActive = Math.max(maxActive, g.npcs.filter((n) => n.active).length);
    }
    if (g.cleared) clears++; tsum += g.time; falls += g.player.falls;
  }
  console.log(name, 'clear', clears + '/' + R, 'avgT', (tsum / R).toFixed(2), 'avgFalls', (falls / R).toFixed(2), 'maxActive', maxActive, 'ms', Date.now() - t0, 'course', COURSE);
}
{ const g = new Game(1); console.log('npcs at start', g.npcs.filter(n => n.active).length, 'rank', g.rank()); }
