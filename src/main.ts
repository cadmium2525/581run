import './style.css';
import { COURSE, DT, Game, N_TOTAL, PState } from './game';
import { Renderer, type Quality } from './render';
import { Input } from './input';
import { Sfx } from './audio';
import { hashString, todayJST } from './rng';

type Mode = 'daily' | 'free';
type Scene = 'title' | 'countdown' | 'race' | 'paused' | 'result';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const fmtRank = (n: number) => n.toLocaleString('ja-JP');
const fmtTime = (t: number) => t.toFixed(3);

// ---- 保存（端末内のみ。サーバーには何も送らない） ----
const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem('581run.' + key);
    } catch {
      return null;
    }
  },
  set(key: string, v: string) {
    try {
      localStorage.setItem('581run.' + key, v);
    } catch {
      /* プライベートモード等では保存しない */
    }
  },
};

const canvas = $<HTMLCanvasElement>('gl');
const renderer = new Renderer(canvas);
const input = new Input($('touch'), $('stepBtn'), $('dashBtn'));
const sfx = new Sfx();

let quality = (store.get('quality') as Quality) || 'auto';
let soundOn = store.get('sound') !== 'off';
renderer.setQuality(quality);
sfx.setEnabled(soundOn);

let mode: Mode = 'daily';
let seed = 0;
let dateKey = todayJST();
let game = new Game(hashString('581run-' + dateKey));
let scene: Scene = 'title';
let acc = 0;
let countdownT = 0;
let lastCount = 0;
let lastStepBeat = 0;
let rankMilestone = 0;
let toastT = 0;

const screens = ['title', 'how', 'settings', 'pause', 'result'];
function show(id: string | null) {
  for (const s of screens) $(s).classList.toggle('hidden', s !== id);
  const racing = id === null;
  $('hud').classList.toggle('hidden', !racing);
  $('controls').classList.toggle('hidden', !racing);
}

function resize() {
  renderer.resize(window.innerWidth, window.innerHeight);
}
window.addEventListener('resize', resize);
resize();

function refreshTitle() {
  dateKey = todayJST();
  $('dailyLabel').textContent = `今日のレース ${dateKey.replace(/-/g, '/')}`;
  const all = store.get('best.all');
  const daily = store.get('best.daily.' + dateKey);
  const parts: string[] = [];
  if (daily) parts.push(`今日のベスト ${daily}秒`);
  if (all) parts.push(`自己ベスト ${all}秒`);
  $('bestLabel').textContent = parts.join(' ／ ');
}

function newGame(m: Mode) {
  mode = m;
  dateKey = todayJST();
  seed = m === 'daily' ? hashString('581run-' + dateKey) : (Math.random() * 2 ** 31) >>> 0;
  game = new Game(seed);
  renderer.snapCamera(game);
  acc = 0;
  lastStepBeat = 0;
  rankMilestone = 0;
  input.reset();
}

function startRace(m: Mode) {
  sfx.unlock();
  newGame(m);
  scene = 'countdown';
  countdownT = 3.0;
  lastCount = 4;
  show(null);
  $('countdown').textContent = '';
  setToast('');
  updateHud();
}

function setToast(text: string, dur = 1.6) {
  const el = $('toast');
  el.textContent = text;
  el.classList.toggle('show', !!text);
  toastT = text ? dur : 0;
}

function pause() {
  if (scene !== 'race' && scene !== 'countdown') return;
  scene = 'paused';
  show('pause');
  sfx.setCrowd(0);
}
function resume() {
  if (scene !== 'paused') return;
  scene = game.started ? 'race' : 'countdown';
  acc = 0;
  show(null);
}

const MILESTONES = [1_000_000, 100_000, 10_000, 1_000, 100, 10];
const MILESTONE_TEXT = ['100万位以内！', '10万位以内！', '1万位以内！', '1000位以内！', 'ついに100位以内！', 'トップ10！'];

function handleEvents() {
  const p = game.player;
  for (const e of game.events) {
    switch (e.type) {
      case 'npcFall':
        sfx.npcFall(Math.hypot(e.x - p.x, e.z - p.z));
        break;
      case 'bump':
        sfx.bump();
        break;
      case 'trip':
        sfx.trip();
        break;
      case 'playerFall':
        sfx.playerFall();
        if (navigator.vibrate) navigator.vibrate(120);
        setToast('転んだ！');
        break;
      case 'sidestep':
        sfx.whoosh();
        break;
      case 'hop':
        sfx.hop();
        break;
      case 'passLeader':
        sfx.passLeader();
        setToast('1位！ そのままゴールへ！', 2.2);
        break;
      case 'leaderFinish':
        if (!game.leaderPassed) setToast('先頭がゴールした…！', 2.2);
        break;
      case 'finish':
        finishRace();
        break;
    }
  }
  renderer.onEvents(game.events, game);
  // 順位の節目
  const r = game.rank();
  while (rankMilestone < MILESTONES.length && r <= MILESTONES[rankMilestone]) {
    if (!game.leaderPassed) setToast(MILESTONE_TEXT[rankMilestone]);
    rankMilestone++;
  }
  // 足音
  if (p.state === PState.Run && p.y === 0) {
    const beat = Math.floor((p.phase * 2.2) / Math.PI);
    if (beat !== lastStepBeat) {
      lastStepBeat = beat;
      sfx.step();
    }
  }
}

function finishRace() {
  scene = 'result';
  sfx.setCrowd(0.3);
  const t = game.time;
  const cleared = game.cleared;
  sfx.fanfare(cleared);
  let isNew = false;
  if (cleared) {
    const keys = ['best.all'];
    if (mode === 'daily') keys.push('best.daily.' + dateKey);
    for (const k of keys) {
      const prev = parseFloat(store.get(k) ?? '');
      if (!(prev <= t)) {
        store.set(k, fmtTime(t));
        isNew = true;
      }
    }
  }
  const best = mode === 'daily' ? store.get('best.daily.' + dateKey) : store.get('best.all');
  $('resMode').textContent = mode === 'daily' ? `今日のレース ${dateKey.replace(/-/g, '/')}` : `フリーラン #${seed % 1000000}`;
  const head = $('resHead');
  head.textContent = cleared ? '1位でゴール！' : `${fmtRank(game.finishRank)}位でゴール`;
  head.classList.toggle('lose', !cleared);
  $('resTime').innerHTML = `${fmtTime(t)}<small>秒</small>`;
  $('resNew').classList.toggle('hidden', !isNew);
  $('resRank').textContent = `${fmtRank(game.finishRank)}位`;
  $('resFalls').textContent = `${game.player.falls}回`;
  $('resBest').textContent = best ? `${best}秒` : '-';
  const passed = N_TOTAL - game.finishRank;
  $('resMsg').textContent = cleared
    ? `5,812,374人をぜんぶ抜いた！`
    : `${fmtRank(passed)}人抜き！ 先頭より先にゴールすればクリア。もう一回！`;
  $('shareNote').textContent = '';
  setTimeout(() => {
    if (scene === 'result') show('result');
  }, 900);
}

function shareText(): string {
  const t = fmtTime(game.time);
  const where = mode === 'daily' ? `【今日のレース ${dateKey.replace(/-/g, '/')}】` : '【フリーラン】';
  const body = game.cleared
    ? `5,812,375位から1位に！ タイム ${t}秒（転倒${game.player.falls}回）`
    : `5,812,375位から${fmtRank(game.finishRank)}位まで追い上げた！（${t}秒）`;
  return `581万人100m走 ${where}\n${body}\n#581万人100m走`;
}

async function share() {
  const text = shareText();
  const url = location.href.split('#')[0].split('?')[0];
  try {
    if (navigator.share) {
      await navigator.share({ text, url });
      return;
    }
  } catch {
    return; // キャンセル
  }
  const intent = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
  window.open(intent, '_blank', 'noopener');
  try {
    await navigator.clipboard.writeText(`${text}\n${url}`);
    $('shareNote').textContent = '結果をクリップボードにコピーしました';
  } catch {
    /* noop */
  }
}

function updateHud() {
  const p = game.player;
  $('hudTime').textContent = fmtTime(game.time);
  const r = game.rank();
  $('hudRank').textContent = fmtRank(r);
  $('hudRank').parentElement!.classList.toggle('first', r === 1);
  $('hudDist').textContent = Math.max(0, COURSE - p.z).toFixed(1);
  $('progMe').style.left = `${Math.min(100, (p.z / COURSE) * 100)}%`;
  $('progLeader').style.left = `${Math.min(100, (game.front / COURSE) * 100)}%`;
  const bal = $('balBar');
  bal.style.width = `${p.state === PState.Run ? p.balance : 0}%`;
  bal.classList.toggle('low', p.balance < 35);
  $('staBar').style.width = `${p.stamina * 100}%`;
}

// ---- メインループ ----
let last = performance.now();
function frame(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  if (scene === 'countdown') {
    countdownT -= dt;
    const c = Math.ceil(countdownT);
    if (c !== lastCount && c > 0) {
      lastCount = c;
      $('countdown').textContent = String(c);
      sfx.beep();
    }
    if (countdownT <= 0) {
      $('countdown').textContent = 'GO!';
      sfx.pistol();
      sfx.setCrowd(1);
      setTimeout(() => {
        if ($('countdown').textContent === 'GO!') $('countdown').textContent = '';
      }, 700);
      game.start();
      scene = 'race';
      acc = 0;
    }
  } else if (scene === 'race') {
    acc += dt;
    // 固定タイムステップ（端末の fps に依存しない）
    let n = 0;
    while (acc >= DT && n < 8 && scene === 'race') {
      game.update(input.read());
      handleEvents();
      acc -= DT;
      n++;
    }
    if (n === 8) acc = 0;
    updateHud();
  }
  if (toastT > 0) {
    toastT -= dt;
    if (toastT <= 0) setToast('');
  }
  renderer.render(game, scene === 'paused' ? 0 : dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---- UI 配線 ----
$('playDaily').onclick = () => startRace('daily');
$('playFree').onclick = () => startRace('free');
$('againBtn').onclick = () => startRace(mode);
$('retryBtn').onclick = () => startRace(mode);
$('resumeBtn').onclick = resume;
$('pauseBtn').addEventListener('pointerdown', (e) => {
  e.stopPropagation();
  pause();
});
const toTitle = () => {
  scene = 'title';
  sfx.setCrowd(0);
  newGame('daily');
  refreshTitle();
  show('title');
};
$('toTitleBtn').onclick = toTitle;
$('resTitleBtn').onclick = toTitle;
$('shareBtn').onclick = () => void share();
$('howBtn').onclick = () => show('how');
$('settingsBtn').onclick = () => {
  syncSettings();
  show('settings');
};
document.querySelectorAll('.back').forEach((b) => ((b as HTMLElement).onclick = () => show('title')));

function syncSettings() {
  document.querySelectorAll('#qualitySeg button').forEach((b) => b.classList.toggle('on', (b as HTMLElement).dataset.v === quality));
  document.querySelectorAll('#soundSeg button').forEach((b) => b.classList.toggle('on', ((b as HTMLElement).dataset.v === 'on') === soundOn));
}
document.querySelectorAll('#qualitySeg button').forEach((b) =>
  b.addEventListener('click', () => {
    quality = (b as HTMLElement).dataset.v as Quality;
    store.set('quality', quality);
    renderer.setQuality(quality);
    syncSettings();
  }),
);
document.querySelectorAll('#soundSeg button').forEach((b) =>
  b.addEventListener('click', () => {
    soundOn = (b as HTMLElement).dataset.v === 'on';
    store.set('sound', soundOn ? 'on' : 'off');
    sfx.unlock();
    sfx.setEnabled(soundOn);
    syncSettings();
  }),
);

input.onPause = () => {
  if (scene === 'paused') resume();
  else pause();
};
input.onAnyKey = (code) => {
  if (scene === 'result' && (code === 'KeyR' || code === 'Enter')) startRace(mode);
  else if (scene === 'title' && code === 'Enter') startRace('daily');
};
document.addEventListener('visibilitychange', () => {
  if (document.hidden) pause();
});

window.addEventListener('touchstart', () => document.body.classList.add('touch'), { once: true, passive: true });

refreshTitle();
show('title');
