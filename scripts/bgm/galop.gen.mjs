// 「天国と地獄」（オッフェンバック『地獄のオルフェ』序曲のギャロップ、1858年・パブリックドメイン）風の
// 運動会 BGM を、かなでる（https://github.com/cadmium2525/mp4mp3 の daw/）の曲 JSON として作る。
//
//   node scripts/bgm/galop.gen.mjs > scripts/bgm/galop.json
//   node <mp4mp3>/daw/tools/render.mjs scripts/bgm/galop.json /tmp/galop.wav --mp3 src/assets/bgm.mp3 --report
//
// 2/4 拍子・176 BPM。A（有名な主題）→ A'（にぎやかに）→ B（オリジナルの中間部）の 48 小節でループする。
// ループのつなぎ目を自然にするため、最後に 1 小節目と同じ内容を 1 小節ぶん足して書き出す（ゲーム側で 96 拍目で巻き戻す）。

const BEAT = 2; // 1 小節の拍数
const LOOP_BARS = 48;

// 主題 A（16 小節）。[音, 長さ(拍)]、null は休符
const A = [
  [['C5', 2]],
  [['D5', 0.5], ['F5', 0.5], ['E5', 0.5], ['D5', 0.5]],
  [['G5', 1], ['G5', 1]],
  [['G5', 0.5], ['A5', 0.5], ['E5', 0.5], ['F5', 0.5]],
  [['D5', 1], ['D5', 1]],
  [['D5', 0.5], ['F5', 0.5], ['E5', 0.5], ['D5', 0.5]],
  [['C5', 0.5], ['C6', 0.5], ['B5', 0.5], ['A5', 0.5]],
  [['G5', 0.5], ['F5', 0.5], ['E5', 0.5], ['D5', 0.5]],
  [['C5', 2]],
  [['D5', 0.5], ['F5', 0.5], ['E5', 0.5], ['D5', 0.5]],
  [['G5', 1], ['G5', 1]],
  [['G5', 0.5], ['A5', 0.5], ['E5', 0.5], ['F5', 0.5]],
  [['D5', 1], ['D5', 1]],
  [['D5', 0.5], ['F5', 0.5], ['E5', 0.5], ['D5', 0.5]],
  [['C5', 0.5], ['G5', 0.5], ['D5', 0.5], ['E5', 0.5]],
  [['C5', 1], [null, 1]],
];
const A_CH = ['C', 'C', 'C', 'C', 'G7', 'G7', 'C', 'G7', 'C', 'C', 'C', 'C', 'G7', 'G7', ['C', 'G7'], 'C'];

// 中間部 B（16 小節、オリジナル）
const q4 = (a, b, c, d) => [[a, 0.5], [b, 0.5], [c, 0.5], [d, 0.5]];
const B = [
  q4('E5', 'E5', 'E5', 'E5'),
  q4('F5', 'E5', 'D5', 'C5'),
  q4('D5', 'D5', 'D5', 'D5'),
  q4('E5', 'D5', 'C5', 'B4'),
  q4('F5', 'F5', 'F5', 'F5'),
  q4('G5', 'F5', 'E5', 'D5'),
  q4('E5', 'E5', 'E5', 'E5'),
  q4('D5', 'C5', 'B4', 'G4'),
  q4('C5', 'D5', 'E5', 'F5'),
  q4('G5', 'A5', 'B5', 'C6'),
  [['A5', 1], ['F5', 1]],
  [['G5', 1], ['E5', 1]],
  [['F5', 1], ['D5', 1]],
  [['B4', 1], ['G4', 1]],
  [['G5', 1], ['G5', 1]],
  q4('G5', 'F5', 'E5', 'D5'),
];
const B_CH = ['C', 'F', 'G7', ['C', 'G7'], 'F', 'Dm', 'C', 'G7', 'C', 'C', 'F', 'C', 'Dm', 'G7', 'G7', 'G7'];

const CH = {
  C: { root: 'C3', fifth: 'G2', tones: ['E4', 'G4', 'C5'] },
  F: { root: 'F2', fifth: 'C3', tones: ['F4', 'A4', 'C5'] },
  G7: { root: 'G2', fifth: 'D3', tones: ['D4', 'F4', 'B4'] },
  Dm: { root: 'D3', fifth: 'A2', tones: ['D4', 'F4', 'A4'] },
};

const sections = [
  { mel: A, ch: A_CH, loud: 0.78 },
  { mel: A, ch: A_CH, loud: 0.9, octave: true },
  { mel: B, ch: B_CH, loud: 0.85 },
];

const lead = [];
const lead8 = [];
const bass = [];
const stab = [];
let bar = 0;
const addBar = (sec, i, at) => {
  let t = at;
  for (const [n, d] of sec.mel[i]) {
    if (n) {
      const v = sec.loud * (t === at ? 1 : 0.88);
      lead.push([t, n, d >= 1 ? d * 0.8 : 0.36, v]);
      if (sec.octave) lead8.push([t, n.replace(/\d/, (o) => String(Number(o) + 1)), 0.3, v * 0.8]);
    }
    t += d;
  }
  const c = sec.ch[i];
  const [c1, c2] = Array.isArray(c) ? c : [c, c];
  // ズン・チャッ（オムパー）
  bass.push([at, CH[c1].root, 0.45, 0.85], [at + 1, CH[c2].fifth, 0.45, 0.75]);
  for (const n of CH[c1].tones) stab.push([at + 0.5, n, 0.22, 0.6]);
  for (const n of CH[c2].tones) stab.push([at + 1.5, n, 0.22, 0.6]);
};
for (const sec of sections) {
  for (let i = 0; i < 16; i++) addBar(sec, i, bar++ * BEAT);
}
// ループのつなぎ用に 1 小節目をもう一度
addBar(sections[0], 0, bar * BEAT);

const drumsBar = (n, kick, snare, hat) => ({ kick: kick.repeat(n), snare: snare.repeat(n), hat: hat.repeat(n) });
const song = {
  name: '581万人100m走 BGM（天国と地獄風ギャロップ）',
  bpm: 176,
  sig: [2, 4],
  bars: LOOP_BARS + 1,
  key: 'C major',
  sends: { reverb: { size: 0.9, decay: 1.2, damp: 7000, predelay: 0.01 } },
  master: { loudness: -16, ceiling: -1 },
  tracks: [
    { id: 'lead', name: '旋律（ブラス）', inst: 'brass', volume: 1, sends: { reverb: 0.15 }, humanize: { time: 0.003, vel: 0.04 }, clips: [{ at: 0, notes: lead }] },
    { id: 'lead8', name: '旋律オクターブ上（グロッケン）', inst: 'glock', volume: -6, pan: 0.2, sends: { reverb: 0.2 }, clips: [{ at: 0, notes: lead8 }] },
    { id: 'bass', name: 'ベース（ズン）', inst: 'ebass', volume: 0, clips: [{ at: 0, notes: bass }] },
    { id: 'stab', name: '和音（チャッ）', inst: 'chordstab', volume: -5, pan: -0.15, sends: { reverb: 0.1 }, clips: [{ at: 0, notes: stab }] },
    {
      id: 'drums', name: 'ドラム', type: 'drums', kit: 'acoustic', volume: -2, sends: { reverb: 0.08 },
      clips: [
        { at: 0, len: 32, grid: { ...drumsBar(16, 'x...x...', '..o...o.', '........'), crash: 'X' } },
        { at: 32, len: 32, grid: { ...drumsBar(16, 'x...x...', '..x...x.', 'x.x.x.x.'), crash: 'X' } },
        { at: 64, len: 28, grid: { ...drumsBar(14, 'x...x...', '..x...x.', 'x.x.x.x.'), crash: 'X', tamb: '..x...x.'.repeat(14) } },
        { at: 92, len: 4, grid: { kick: 'x...x...x...x...', snare: 'x.x.x.x.xxxxXXXX' } },
        { at: 96, len: 2, grid: { kick: 'x...x...', crash: 'X' } },
      ],
    },
  ],
};
process.stdout.write(JSON.stringify(song, null, 1));
