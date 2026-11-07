import './style.css';
import { COURSE, DT, Game, N_TOTAL, PState } from './game';
import { Renderer, type Quality } from './render';
import { Input } from './input';
import { Sfx } from './audio';
import { hashString, todayJST } from './rng';
import bgmUrl from './assets/bgm.mp3';

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
let bgmOn = store.get('bgm') !== 'off';
renderer.setQuality(quality);
sfx.setEnabled(soundOn);
sfx.setBgmEnabled(bgmOn);
sfx.preloadBgm(bgmUrl);

const GAME_URL = location.origin + location.pathname.replace(/index\.html$/, '');
let cardBlob: Blob | null = null;
let cardUrl = '';

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
  if (import.meta.env.DEV) Object.assign(window, { __game: game, __renderer: renderer }); // 開発時のテスト用
  renderer.snapCamera(game);
  acc = 0;
  lastStepBeat = 0;
  rankMilestone = 0;
  input.reset();
}

function startRace(m: Mode) {
  if (cutTimers.length) endCutIn();
  $('cutin').classList.add('hidden');
  sfx.unlock();
  newGame(m);
  sfx.stopBgm(0.2);
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
  sfx.pauseBgm();
}
function resume() {
  if (scene !== 'paused') return;
  scene = game.started ? 'race' : 'countdown';
  acc = 0;
  show(null);
  if (game.started) {
    sfx.unlock();
    sfx.setCrowd(1);
    sfx.playBgm();
  }
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
  sfx.stopBgm(0.8);
  const t = game.time;
  const cleared = game.cleared;
  let cutShots: HTMLCanvasElement[] = [];
  if (cleared) {
    // 1位：バンザイのポーズにして、3 つの視点から撮る
    renderer.victory = true;
    renderer.render(game, 0);
    cutShots = (['face', 'side', 'high'] as const).map((v) => renderer.snapshot(game, 960, 540, v));
  } else sfx.fanfare(false);
  // シェア画像（ゴールの瞬間を正面から撮った写真＋記録）
  const shot = renderer.snapshot(game);
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
  makeCard(shot, best, isNew);
  if (cleared) playCutIn(cutShots);
  else
    setTimeout(() => {
      if (scene === 'result') show('result');
    }, 900);
}

/** 1位ゴールの演出：パシャッ・パシャッ・パシャッ！と 3 視点のドアップを重ねる */
let cutTimers: number[] = [];
function playCutIn(shots: HTMLCanvasElement[]) {
  const root = $('cutin');
  const flash = $('cutFlash');
  root.querySelectorAll('.cut, .stamp').forEach((e) => e.remove());
  root.classList.remove('hidden', 'dim');
  $('hud').classList.add('hidden');
  $('controls').classList.add('hidden');
  const at = (ms: number, fn: () => void) => cutTimers.push(window.setTimeout(fn, ms));
  const doFlash = () => {
    flash.classList.remove('on');
    void flash.offsetWidth; // アニメーションをやり直す
    flash.classList.add('on');
  };
  shots.forEach((cv, i) =>
    at(120 + i * 380, () => {
      const d = document.createElement('div');
      d.className = `cut c${i + 1}`;
      d.appendChild(cv);
      root.appendChild(d);
      root.classList.add('dim');
      doFlash();
      sfx.shutter();
      if (navigator.vibrate) navigator.vibrate(20);
    }),
  );
  at(120 + 3 * 380 + 120, () => {
    const s = document.createElement('div');
    s.className = 'stamp';
    s.innerHTML = '1位!!<small>GOAL</small>';
    root.appendChild(s);
    sfx.fanfare(true);
  });
  at(3400, endCutIn);
  root.onclick = () => {
    if (cutTimers.length) endCutIn();
  };
}

function endCutIn() {
  cutTimers.forEach((t) => clearTimeout(t));
  cutTimers = [];
  $('cutin').classList.add('hidden');
  if (scene === 'result') show('result');
}

function modeLabel(): string {
  return mode === 'daily' ? `今日のレース ${dateKey.replace(/-/g, '/')}` : 'フリーラン';
}

/** 投稿文（記録・URL・タグ） */
function shareText(): string {
  const t = fmtTime(game.time);
  const body = game.cleared
    ? `5,812,375位から1位でゴール！\nタイム ${t}秒（転倒${game.player.falls}回）`
    : `5,812,375位から${fmtRank(game.finishRank)}位まで追い上げた！\nタイム ${t}秒（転倒${game.player.falls}回）`;
  return `581万人100m走【${modeLabel()}】\n${body}\n${GAME_URL}\n#581万人100m走`;
}

/** 結果画像（1200×630） */
function makeCard(shot: HTMLCanvasElement, best: string | null, isNew: boolean) {
  cardBlob = null;
  $<HTMLButtonElement>('shareBtn').disabled = true;
  $<HTMLButtonElement>('saveBtn').disabled = true;
  const W = 1200;
  const H = 630;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  g.drawImage(shot, 0, 0, W, H);
  const grad = g.createLinearGradient(0, 0, W * 0.75, 0);
  grad.addColorStop(0, 'rgba(14,20,48,0.86)');
  grad.addColorStop(0.55, 'rgba(14,20,48,0.55)');
  grad.addColorStop(1, 'rgba(14,20,48,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  const font = (size: number, weight = 900) =>
    `${weight} ${size}px "Hiragino Kaku Gothic ProN","Hiragino Sans","Noto Sans JP","Yu Gothic",Meiryo,sans-serif`;
  const text = (s: string, x: number, y: number, size: number, color: string, weight = 900) => {
    g.font = font(size, weight);
    g.fillStyle = color;
    g.fillText(s, x, y);
    return g.measureText(s).width;
  };
  g.textBaseline = 'alphabetic';
  const X = 60;
  let w = text('581', X, 108, 76, '#ff5a36');
  w += text('万人', X + w + 4, 108, 44, '#ffffff');
  text('100m走', X + w + 12, 108, 44, '#ffffff');
  text(modeLabel(), X, 156, 26, '#c9d4ff', 700);
  text(game.cleared ? '1位でゴール！' : `${fmtRank(game.finishRank)}位でゴール`, X, 238, 52, game.cleared ? '#ffd23f' : '#ffffff');
  w = text(fmtTime(game.time), X, 372, 132, '#ffffff');
  text('秒', X + w + 10, 372, 44, '#ffffff');
  text(`5,812,375位 → ${fmtRank(game.finishRank)}位`, X, 440, 34, '#ffffff', 700);
  let line = `転倒 ${game.player.falls}回`;
  if (best) line += `　自己ベスト ${best}秒`;
  text(line, X, 490, 28, '#c9d4ff', 700);
  if (isNew) {
    g.fillStyle = '#ffc21a';
    if (g.roundRect) {
      g.beginPath();
      g.roundRect(X, 512, 236, 46, 10);
      g.fill();
    } else g.fillRect(X, 512, 236, 46);
    text('自己ベスト更新！', X + 16, 546, 28, '#1c2340');
  }
  text('#581万人100m走', X, 600, 26, '#ffffff', 700);
  g.textAlign = 'right';
  text(GAME_URL.replace(/^https?:\/\//, ''), W - 30, 600, 22, 'rgba(255,255,255,0.85)', 700);
  g.textAlign = 'left';
  c.toBlob((b) => {
    if (!b) return;
    cardBlob = b;
    if (cardUrl) URL.revokeObjectURL(cardUrl);
    cardUrl = URL.createObjectURL(b);
    const img = $<HTMLImageElement>('resCard');
    img.src = cardUrl;
    img.classList.remove('hidden');
    $<HTMLButtonElement>('shareBtn').disabled = false;
    $<HTMLButtonElement>('saveBtn').disabled = false;
  }, 'image/png');
}

function cardFile(): File | null {
  return cardBlob ? new File([cardBlob], `581run-${fmtTime(game.time)}.png`, { type: 'image/png' }) : null;
}

function saveCard() {
  if (!cardUrl) return;
  const a = document.createElement('a');
  a.href = cardUrl;
  a.download = `581run-${fmtTime(game.time)}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * 共有：対応端末（iPhone / Android など）は共有シートに「画像＋投稿文」を渡す。
 * 非対応（PC など）は X の投稿画面を投稿文入りで開き、画像を保存する（X の投稿画面には画像を自動で添付できないため）。
 * どちらの場合も投稿文はクリップボードにもコピーしておく（アプリによって文章が消えることがあるため）。
 */
async function share() {
  const text = shareText();
  const note = $('shareNote');
  let copied = false;
  navigator.clipboard
    ?.writeText(text)
    .then(() => (copied = true))
    .catch(() => {});
  const file = cardFile();
  if (file && navigator.canShare?.({ files: [file], text })) {
    try {
      await navigator.share({ files: [file], text });
      note.textContent = copied ? '投稿文はコピー済みです。文章が入っていなければ貼り付けてください' : '';
      return;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
    }
  }
  window.open(`https://x.com/intent/post?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
  saveCard();
  note.textContent = '画像を保存しました。投稿画面で画像を添付してください';
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
      sfx.playBgm(true);
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
  sfx.stopBgm(0.3);
  newGame('daily');
  refreshTitle();
  show('title');
};
$('toTitleBtn').onclick = toTitle;
$('resTitleBtn').onclick = toTitle;
$('shareBtn').onclick = () => void share();
$('saveBtn').onclick = saveCard;
$('howBtn').onclick = () => show('how');
$('settingsBtn').onclick = () => {
  syncSettings();
  show('settings');
};
document.querySelectorAll('.back').forEach((b) => ((b as HTMLElement).onclick = () => show('title')));

function syncSettings() {
  document.querySelectorAll('#qualitySeg button').forEach((b) => b.classList.toggle('on', (b as HTMLElement).dataset.v === quality));
  document.querySelectorAll('#bgmSeg button').forEach((b) =>
  b.addEventListener('click', () => {
    bgmOn = (b as HTMLElement).dataset.v === 'on';
    store.set('bgm', bgmOn ? 'on' : 'off');
    sfx.unlock();
    sfx.setBgmEnabled(bgmOn);
    syncSettings();
  }),
);
document.querySelectorAll('#soundSeg button').forEach((b) => b.classList.toggle('on', ((b as HTMLElement).dataset.v === 'on') === soundOn));
  document.querySelectorAll('#bgmSeg button').forEach((b) => b.classList.toggle('on', ((b as HTMLElement).dataset.v === 'on') === bgmOn));
}
document.querySelectorAll('#qualitySeg button').forEach((b) =>
  b.addEventListener('click', () => {
    quality = (b as HTMLElement).dataset.v as Quality;
    store.set('quality', quality);
    renderer.setQuality(quality);
    syncSettings();
  }),
);
document.querySelectorAll('#bgmSeg button').forEach((b) =>
  b.addEventListener('click', () => {
    bgmOn = (b as HTMLElement).dataset.v === 'on';
    store.set('bgm', bgmOn ? 'on' : 'off');
    sfx.unlock();
    sfx.setBgmEnabled(bgmOn);
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
