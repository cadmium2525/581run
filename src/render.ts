/**
 * Three.js による描画。グラウンド全体を 1 つの群衆として、3 段階 LOD で描く：
 *  - 近景：判定ウィンドウ内の子（パーツ分けした低ポリ人形を InstancedMesh で描画、走り・転倒モーション）
 *  - 中景：ウィンドウ外の数千人（簡易人型。位置・走りアニメはすべて GPU で計算）
 *  - 遠景：地平線まで続く点群（GPU だけで動かす）
 * 中景・遠景は game.ts と同じ密度分布（先頭〜最後尾）から配置するので、近景と切れ目なくつながる。
 * ゲームの当たり判定は game.ts 側のみ。ここは見た目専用。
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { AHEAD, BEHIND, COURSE, Game, NEAR_HW, NState, PState, densityShape, type GameEvent } from './game';

export type Quality = 'low' | 'auto' | 'high';

const SKY = 0xc4e4ff;
const HAT_COLORS = [new THREE.Color(0xe63b3b), new THREE.Color(0xf7f7f2), new THREE.Color(0xffc21a)];
const SHIRT = new THREE.Color(0xfbfbf6);
const SKIN = 0xf2c49b;
const SHORTS = 0x1f2f6b;

const MID_MAX = 6000; // 中景の最大人数
const MID_W_MAX = 260; // 中景を敷き詰める横幅（m）
const FAR_MAX = 120000;

function box(w: number, h: number, d: number, ox: number, oy: number) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(ox, oy, 0);
  return g;
}

const P_TORSO = 0;
const P_SHORTS = 1;
const P_HEAD = 2;
const P_HAT = 3;
const P_LEG_L = 4;
const P_LEG_R = 5;
const P_ARM_L = 6;
const P_ARM_R = 7;

interface Part {
  geo: THREE.BufferGeometry;
  color: number;
  instanceColor: boolean;
}

function hatGeometry(detail: number) {
  const hat = new THREE.SphereGeometry(0.17, detail, Math.max(3, detail / 2), 0, Math.PI * 2, 0, Math.PI / 2);
  const brim = new THREE.CylinderGeometry(0.13, 0.13, 0.02, detail);
  brim.scale(1, 1, 1.2);
  brim.translate(0, 0, 0.1);
  return mergeGeometries([hat.toNonIndexed(), brim.toNonIndexed()])!;
}

function makeParts(): Part[] {
  return [
    { geo: box(0.32, 0.36, 0.2, 0, 0), color: 0xffffff, instanceColor: true },
    { geo: box(0.33, 0.16, 0.21, 0, 0), color: SHORTS, instanceColor: false },
    { geo: new THREE.IcosahedronGeometry(0.155, 1), color: 0xf4c9a0, instanceColor: false },
    { geo: hatGeometry(10), color: 0xffffff, instanceColor: true },
    { geo: box(0.11, 0.56, 0.12, 0, -0.28), color: SKIN, instanceColor: false },
    { geo: box(0.11, 0.56, 0.12, 0, -0.28), color: SKIN, instanceColor: false },
    { geo: box(0.08, 0.38, 0.08, 0, -0.17), color: SKIN, instanceColor: false },
    { geo: box(0.08, 0.38, 0.08, 0, -0.17), color: SKIN, instanceColor: false },
  ];
}

interface Pose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  fall: number; // 0=直立, 1=うつ伏せ
  roll: number;
  swing: number;
  armUp: number;
  lean: number;
  bob: number;
}

const _m = new THREE.Matrix4();
const _base = new THREE.Matrix4();
const _t = new THREE.Matrix4();
const _r = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _c = new THREE.Color();

/** パーツ単位の行列（ゲーム座標 x(右+) → three 座標 -x。カメラが +z を向くため） */
function partMatrices(pose: Pose, out: THREE.Matrix4[]) {
  _e.set(pose.lean + pose.fall * (Math.PI / 2 - 0.12), pose.yaw, pose.roll, 'YXZ');
  _q.setFromEuler(_e);
  _v.set(-pose.x, pose.y + pose.bob + pose.fall * 0.12, pose.z);
  _base.compose(_v, _q, _s);
  const sw = pose.swing;
  const hipY = 0.62;
  const set = (i: number, px: number, py: number, pz: number, rx: number, rz = 0) => {
    _t.makeTranslation(px, py, pz);
    _e.set(rx, 0, rz);
    _r.makeRotationFromEuler(_e);
    _m.multiplyMatrices(_t, _r);
    out[i].multiplyMatrices(_base, _m);
  };
  set(P_TORSO, 0, hipY + 0.26, 0, 0);
  set(P_SHORTS, 0, hipY + 0.02, 0, 0);
  set(P_HEAD, 0, hipY + 0.6, 0.01, 0);
  set(P_HAT, 0, hipY + 0.64, 0.0, -0.08);
  const splay = pose.fall * 0.35;
  set(P_LEG_L, 0.085, hipY, 0, sw, splay);
  set(P_LEG_R, -0.085, hipY, 0, -sw, -splay);
  const armSw = -sw * 0.9;
  const up = pose.armUp;
  set(P_ARM_L, 0.2, hipY + 0.42, 0, armSw * (1 - up) - up * 2.6, 0.15 + up * 0.5 + splay);
  set(P_ARM_R, -0.2, hipY + 0.42, 0, -armSw * (1 - up) - up * 2.6, -0.15 - up * 0.5 - splay);
}

function makeLabelTexture(text: string, color: string, size = 128, font = 'bold 96px sans-serif', stroke = '#000') {
  const c = document.createElement('canvas');
  c.width = size * 2;
  c.height = size;
  const g = c.getContext('2d')!;
  g.font = font;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 12;
  g.strokeStyle = stroke;
  g.strokeText(text, size, size / 2);
  g.fillStyle = color;
  g.fillText(text, size, size / 2);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** 群衆の密度分布どおりに u（0=先頭,1=最後尾）をサンプリング */
function sampleU(rnd: () => number): number {
  for (;;) {
    const u = rnd();
    if (rnd() < densityShape(u)) return u;
  }
}

function seeded(seed: number) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

const FX_WORDS = ['どたっ', 'ぽてっ', 'ずてーん', 'ころん', 'べちゃ'];

const CROWD_UNIFORMS = () => ({
  uTime: { value: 0 },
  uRun: { value: 0 },
  uFront: { value: 0 },
  uBack: { value: 0 },
  uPx: { value: 0 },
  uPz: { value: 0 },
  uW: { value: MID_W_MAX },
  uNearHW: { value: NEAR_HW },
  uAhead: { value: AHEAD },
  uBehind: { value: BEHIND },
  uFog: { value: new THREE.Color(SKY) },
  uScale: { value: 300 },
});

// 群衆の位置計算（中景・遠景で共通）
const CROWD_GLSL = /* glsl */ `
  uniform float uTime, uRun, uFront, uBack, uPx, uPz, uW, uNearHW, uAhead, uBehind;
  float crowdZ(float u, float ph) {
    return uBack + (1.0 - u) * (uFront - uBack) + sin(uTime * 0.6 + ph * 6.28) * 0.35 * uRun;
  }
  bool inNear(float x, float z) {
    return abs(x - uPx) < uNearHW + 0.6 && z > uPz - uBehind - 1.5 && z < uPz + uAhead + 2.0;
  }
`;

export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private near: THREE.InstancedMesh[] = [];
  private nearShadow: THREE.InstancedMesh;
  private hazard: THREE.InstancedMesh;
  private playerParts: THREE.Mesh[] = [];
  private playerMats: THREE.Matrix4[] = [];
  private playerShadow: THREE.Mesh;
  private playerRing: THREE.Mesh;
  private playerMarker: THREE.Mesh;
  private tmpMats: THREE.Matrix4[] = [];
  private mid!: THREE.Mesh;
  private midGeo!: THREE.InstancedBufferGeometry;
  private midMat!: THREE.ShaderMaterial;
  private far!: THREE.Points;
  private farMat!: THREE.ShaderMaterial;
  private tiled: { obj: THREE.Object3D; step: number }[] = [];
  private goalBanner!: THREE.Group;
  private warnSprites: THREE.Sprite[] = [];
  private fxSprites: { s: THREE.Sprite; t: number; vy: number }[] = [];
  private fxTex: THREE.Texture[] = [];
  private dust: { s: THREE.Sprite; t: number; vx: number; vz: number }[] = [];
  private camPos = new THREE.Vector3(0, 6, -7);
  private camLook = new THREE.Vector3(0, 1, 8);
  private shake = 0;
  private clock = 0;
  quality: Quality = 'auto';
  private pixelRatio = 1;
  private fpsAcc = 0;
  private fpsFrames = 0;
  private level = 2; // 自動調整レベル 0..3
  private width = 1;
  private height = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene.background = new THREE.Color(SKY);
    this.scene.fog = new THREE.Fog(SKY, 50, 520);
    this.camera = new THREE.PerspectiveCamera(62, 1, 0.1, 1600);

    this.scene.add(new THREE.HemisphereLight(0xeaf6ff, 0x9a7a55, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-30, 60, -20);
    this.scene.add(sun);

    this.buildField();

    // 近景の子ども（パーツごとに InstancedMesh）
    const parts = makeParts();
    for (const p of parts) {
      const m = new THREE.InstancedMesh(p.geo, new THREE.MeshLambertMaterial({ color: p.color }), Game.POOL);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      if (p.instanceColor) m.setColorAt(0, SHIRT);
      m.count = 0;
      this.near.push(m);
      this.scene.add(m);
    }
    for (let i = 0; i < parts.length; i++) {
      this.tmpMats.push(new THREE.Matrix4());
      this.playerMats.push(new THREE.Matrix4());
    }
    const shadowGeo = new THREE.CircleGeometry(0.3, 12);
    shadowGeo.rotateX(-Math.PI / 2);
    const shadowMat = new THREE.MeshBasicMaterial({ color: 0x5a3a1a, transparent: true, opacity: 0.3, depthWrite: false });
    this.nearShadow = new THREE.InstancedMesh(shadowGeo, shadowMat, Game.POOL);
    this.nearShadow.frustumCulled = false;
    this.nearShadow.renderOrder = 1;
    this.scene.add(this.nearShadow);
    const ringGeo = new THREE.RingGeometry(0.42, 0.62, 20);
    ringGeo.rotateX(-Math.PI / 2);
    this.hazard = new THREE.InstancedMesh(
      ringGeo,
      new THREE.MeshBasicMaterial({ color: 0xff3b30, transparent: true, opacity: 0.6, depthWrite: false }),
      Game.POOL,
    );
    this.hazard.frustumCulled = false;
    this.hazard.renderOrder = 2;
    this.scene.add(this.hazard);

    // プレイヤー（オレンジのシャツ＋青い帽子）
    const pColors = [0xff7a1a, SHORTS, 0xf4c9a0, 0x2fa8ff, SKIN, SKIN, SKIN, SKIN];
    parts.forEach((p, i) => {
      const mesh = new THREE.Mesh(p.geo, new THREE.MeshLambertMaterial({ color: pColors[i] }));
      mesh.matrixAutoUpdate = false;
      this.playerParts.push(mesh);
      this.scene.add(mesh);
    });
    this.playerShadow = new THREE.Mesh(shadowGeo, shadowMat);
    this.scene.add(this.playerShadow);
    const pr = new THREE.RingGeometry(0.45, 0.6, 28);
    pr.rotateX(-Math.PI / 2);
    this.playerRing = new THREE.Mesh(pr, new THREE.MeshBasicMaterial({ color: 0x2fa8ff, transparent: true, opacity: 0.85, depthWrite: false }));
    this.playerRing.renderOrder = 3;
    this.scene.add(this.playerRing);
    const markerGeo = new THREE.ConeGeometry(0.22, 0.4, 4);
    markerGeo.rotateX(Math.PI);
    this.playerMarker = new THREE.Mesh(markerGeo, new THREE.MeshBasicMaterial({ color: 0x2fa8ff }));
    this.scene.add(this.playerMarker);

    // 前兆「！」・擬音・土ぼこり
    const warnTex = makeLabelTexture('!', '#ffd400', 64, 'bold 60px sans-serif');
    for (let i = 0; i < 60; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: warnTex, depthTest: false, transparent: true }));
      s.scale.set(0.9, 0.45, 1);
      s.visible = false;
      s.renderOrder = 10;
      this.warnSprites.push(s);
      this.scene.add(s);
    }
    this.fxTex = FX_WORDS.map((w) => makeLabelTexture(w, '#ffffff', 128, 'bold 64px sans-serif', '#ff5a36'));
    for (let i = 0; i < 12; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.fxTex[0], depthTest: false, transparent: true }));
      s.visible = false;
      s.renderOrder = 11;
      this.fxSprites.push({ s, t: 0, vy: 0 });
      this.scene.add(s);
    }
    const dustTex = (() => {
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const g = c.getContext('2d')!;
      const grd = g.createRadialGradient(32, 32, 2, 32, 32, 30);
      grd.addColorStop(0, 'rgba(255,245,225,0.9)');
      grd.addColorStop(1, 'rgba(255,245,225,0)');
      g.fillStyle = grd;
      g.fillRect(0, 0, 64, 64);
      return new THREE.CanvasTexture(c);
    })();
    for (let i = 0; i < 60; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: dustTex, transparent: true, depthWrite: false }));
      s.visible = false;
      this.dust.push({ s, t: 0, vx: 0, vz: 0 });
      this.scene.add(s);
    }

    this.buildMidCrowd();
    this.buildFarCrowd();
  }

  /** 地平線まで続く巨大グラウンド */
  private buildField() {
    // 土のテクスチャ（細かい粒＋うっすらしたレーン線で横移動の速さが分かるように）
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d')!;
    g.fillStyle = '#d9ae7e';
    g.fillRect(0, 0, 256, 256);
    const rnd = seeded(4242);
    for (let i = 0; i < 1800; i++) {
      const l = 0.75 + rnd() * 0.4;
      g.fillStyle = `rgba(${Math.round(150 * l)},${Math.round(100 * l)},${Math.round(60 * l)},0.35)`;
      g.fillRect(rnd() * 256, rnd() * 256, 1 + rnd() * 3, 1 + rnd() * 3);
    }
    g.fillStyle = 'rgba(255,255,255,0.28)';
    g.fillRect(0, 0, 3, 256);
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const size = 4000;
    tex.repeat.set(size / 4, size / 4); // 4m ごとにレーン線
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(size, size, 80, 80), new THREE.MeshLambertMaterial({ color: 0xffffff, map: tex }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(0, -0.02, 600);
    this.scene.add(ground);
    this.tiled.push({ obj: ground, step: 4 });

    const W = 4000;
    // スタートライン
    const start = new THREE.Mesh(new THREE.PlaneGeometry(W, 0.15), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    start.rotation.x = -Math.PI / 2;
    start.position.set(0, 0.006, -0.3);
    this.scene.add(start);
    // 10m ごとのライン
    for (let d = 10; d < COURSE; d += 10) {
      const line = new THREE.Mesh(
        new THREE.PlaneGeometry(W, 0.08),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 }),
      );
      line.rotation.x = -Math.PI / 2;
      line.position.set(0, 0.006, d);
      this.scene.add(line);
      // 距離表示（プレイヤーの横位置に合わせて敷き詰める）
      const ltex = makeLabelTexture(`${d}m`, '#ffffff', 128, 'bold 80px sans-serif', '#8a4a20');
      const signGeo = new THREE.PlaneGeometry(2.4, 1.2);
      signGeo.rotateX(-Math.PI / 2);
      signGeo.rotateY(Math.PI);
      const signs = new THREE.InstancedMesh(signGeo, new THREE.MeshBasicMaterial({ map: ltex, transparent: true, depthWrite: false }), 13);
      for (let i = 0; i < 13; i++) {
        _m.makeTranslation((i - 6) * 14, 0.012, d + 0.9);
        signs.setMatrixAt(i, _m);
      }
      signs.frustumCulled = false;
      this.scene.add(signs);
      this.tiled.push({ obj: signs, step: 14 });
    }
    // ゴールライン（市松模様）
    const gc = document.createElement('canvas');
    gc.width = 16;
    gc.height = 16;
    const gg = gc.getContext('2d')!;
    for (let i = 0; i < 2; i++)
      for (let j = 0; j < 2; j++) {
        gg.fillStyle = (i + j) % 2 ? '#111' : '#fff';
        gg.fillRect(i * 8, j * 8, 8, 8);
      }
    const checker = new THREE.CanvasTexture(gc);
    checker.magFilter = THREE.NearestFilter;
    checker.wrapS = checker.wrapT = THREE.RepeatWrapping;
    checker.repeat.set(W / 0.8, 1);
    const goal = new THREE.Mesh(new THREE.PlaneGeometry(W, 0.8), new THREE.MeshBasicMaterial({ map: checker }));
    goal.rotation.x = -Math.PI / 2;
    goal.position.set(0, 0.008, COURSE);
    this.scene.add(goal);
    // ゴールテープとポール（地平線まで）
    const tape = new THREE.Mesh(new THREE.BoxGeometry(W, 0.05, 0.03), new THREE.MeshBasicMaterial({ color: 0xff4d6d }));
    tape.position.set(0, 1.1, COURSE);
    this.scene.add(tape);
    const poleCount = 61;
    const poles = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.1, 0.1, 3.2, 6), new THREE.MeshLambertMaterial({ color: 0xffffff }), poleCount);
    const flags = new THREE.InstancedMesh(new THREE.PlaneGeometry(1.4, 0.8), new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }), poleCount);
    for (let i = 0; i < poleCount; i++) {
      const x = (i - (poleCount - 1) / 2) * 12 + 6; // プレイヤーの正面（x=0）にポールが来ないよう半分ずらす
      _m.makeTranslation(x, 1.6, COURSE);
      poles.setMatrixAt(i, _m);
      _m.makeTranslation(x + 0.7, 2.8, COURSE);
      flags.setMatrixAt(i, _m);
      flags.setColorAt(i, i % 2 ? HAT_COLORS[0] : HAT_COLORS[2]);
    }
    poles.frustumCulled = flags.frustumCulled = false;
    this.scene.add(poles, flags);
    this.tiled.push({ obj: poles, step: 12 }, { obj: flags, step: 12 });
    // 大きな GOAL 看板（プレイヤーの正面に浮かぶ）
    this.goalBanner = new THREE.Group();
    const bannerTex = makeLabelTexture('GOAL', '#ffffff', 256, 'bold 150px sans-serif', '#c0392b');
    const banner = new THREE.Mesh(new THREE.PlaneGeometry(14, 3.5), new THREE.MeshBasicMaterial({ map: bannerTex, transparent: true }));
    banner.rotation.y = Math.PI;
    const back = new THREE.Mesh(new THREE.PlaneGeometry(14.4, 3.8), new THREE.MeshBasicMaterial({ color: 0xd8342a }));
    back.rotation.y = Math.PI;
    back.position.z = 0.03;
    this.goalBanner.add(back, banner);
    this.goalBanner.position.set(0, 7, COURSE);
    this.scene.add(this.goalBanner);
  }

  /** 中景：ウィンドウ外の数千人（GPU で位置と走りを計算） */
  private buildMidCrowd() {
    const setColor = (geo: THREE.BufferGeometry, c: number, hat = 0) => {
      const g = geo.index ? geo.toNonIndexed() : geo;
      const n = g.getAttribute('position').count;
      const col = new Float32Array(n * 3);
      const isHat = new Float32Array(n).fill(hat);
      const cc = new THREE.Color(c);
      for (let i = 0; i < n; i++) cc.toArray(col, i * 3);
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      g.setAttribute('isHat', new THREE.BufferAttribute(isHat, 1));
      g.deleteAttribute('uv');
      return g;
    };
    const head = new THREE.IcosahedronGeometry(0.155, 0);
    head.translate(0, 1.22, 0);
    const hat = hatGeometry(6);
    hat.translate(0, 1.26, 0);
    const base = mergeGeometries([
      setColor(box(0.32, 0.38, 0.2, 0, 0.89), 0xf6f6f0),
      setColor(box(0.33, 0.16, 0.21, 0, 0.64), SHORTS),
      setColor(box(0.11, 0.56, 0.12, 0.085, 0.3), SKIN),
      setColor(box(0.11, 0.56, 0.12, -0.085, 0.3), SKIN),
      setColor(box(0.08, 0.36, 0.08, 0.2, 0.86), SKIN),
      setColor(box(0.08, 0.36, 0.08, -0.2, 0.86), SKIN),
      setColor(head, 0xf4c9a0),
      setColor(hat, 0xffffff, 1),
    ])!;
    const geo = new THREE.InstancedBufferGeometry();
    for (const k of ['position', 'normal', 'color', 'isHat']) geo.setAttribute(k, base.getAttribute(k));
    const aX = new Float32Array(MID_MAX);
    const aU = new Float32Array(MID_MAX);
    const aPh = new Float32Array(MID_MAX);
    const aHat = new Float32Array(MID_MAX);
    const rnd = seeded(13579);
    for (let i = 0; i < MID_MAX; i++) {
      aX[i] = rnd();
      aU[i] = sampleU(rnd);
      aPh[i] = rnd();
      aHat[i] = rnd() < 0.5 ? 0 : 1;
    }
    geo.setAttribute('aX', new THREE.InstancedBufferAttribute(aX, 1));
    geo.setAttribute('aU', new THREE.InstancedBufferAttribute(aU, 1));
    geo.setAttribute('aPh', new THREE.InstancedBufferAttribute(aPh, 1));
    geo.setAttribute('aHat', new THREE.InstancedBufferAttribute(aHat, 1));
    geo.instanceCount = MID_MAX;
    this.midGeo = geo;
    this.midMat = new THREE.ShaderMaterial({
      uniforms: CROWD_UNIFORMS(),
      vertexShader: /* glsl */ `
        ${CROWD_GLSL}
        attribute vec3 color;
        attribute float isHat;
        attribute float aX, aU, aPh, aHat;
        varying vec3 vColor;
        varying float vFog;
        void main() {
          float x0 = uPx - uW * 0.5;
          float x = x0 + mod(aX * uW - x0, uW);
          float z = crowdZ(aU, aPh);
          if (inNear(x, z)) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
          vec3 p = position;
          float ph = uTime * 9.0 + aPh * 6.28;
          float run = uRun;
          // 足と腕を振る（頂点の高さ・左右で判定）
          float leg = step(p.y, 0.58) * sign(p.x) * (0.58 - p.y) * 0.9;
          float arm = step(0.68, p.y) * step(p.y, 1.04) * step(0.15, abs(p.x)) * sign(p.x) * (1.04 - p.y) * 0.8;
          p.z += sin(ph) * (leg - arm) * run;
          p.y += abs(sin(ph)) * 0.06 * run;
          p.z += p.y * 0.12 * run; // 前傾
          vec4 mv = modelViewMatrix * vec4(p + vec3(x, 0.0, z), 1.0);
          gl_Position = projectionMatrix * mv;
          vec3 hatCol = aHat > 0.5 ? vec3(0.95, 0.95, 0.93) : vec3(0.85, 0.16, 0.16);
          vec3 c = mix(color, hatCol, isHat);
          float light = 0.62 + 0.45 * max(dot(normalize(normal), normalize(vec3(0.4, 1.0, -0.3))), 0.0);
          vColor = c * light;
          vFog = smoothstep(50.0, 520.0, -mv.z);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uFog;
        varying vec3 vColor;
        varying float vFog;
        void main() {
          gl_FragColor = vec4(mix(vColor, uFog, vFog), 1.0);
          #include <colorspace_fragment>
        }`,
    });
    this.mid = new THREE.Mesh(geo, this.midMat);
    this.mid.frustumCulled = false;
    this.scene.add(this.mid);
  }

  /** 遠景：中景より外側、地平線まで続く点群 */
  private buildFarCrowd() {
    const count = FAR_MAX;
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const rnd = seeded(987654);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (rnd() < 0.5 ? -1 : 1) * Math.max(0.0005, Math.pow(rnd(), 1.4)); // 横方向（中景の外側からの距離）
      pos[i * 3 + 1] = sampleU(rnd);
      pos[i * 3 + 2] = rnd();
      const c = rnd() < 0.5 ? HAT_COLORS[0] : HAT_COLORS[1];
      c.toArray(col, i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.farMat = new THREE.ShaderMaterial({
      uniforms: CROWD_UNIFORMS(),
      vertexShader: /* glsl */ `
        ${CROWD_GLSL}
        uniform float uScale;
        attribute vec3 color;
        varying vec3 vColor;
        varying float vFog;
        void main() {
          float side = sign(position.x);
          float x = uPx + side * (uW * 0.5 + abs(position.x) * 1400.0);
          float z = crowdZ(position.y, position.z);
          float y = 1.2 + abs(sin(uTime * 9.0 + position.z * 40.0)) * 0.1 * uRun;
          vec4 mv = modelViewMatrix * vec4(x, y, z, 1.0);
          gl_Position = projectionMatrix * mv;
          float d = -mv.z;
          gl_PointSize = clamp(uScale * 0.5 / d, 1.0, 6.0);
          vColor = color;
          vFog = smoothstep(80.0, 900.0, d);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uFog;
        varying vec3 vColor;
        varying float vFog;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          if (dot(c, c) > 0.25) discard;
          gl_FragColor = vec4(mix(vColor, uFog, vFog * 0.8), 1.0);
          #include <colorspace_fragment>
        }`,
    });
    this.far = new THREE.Points(geo, this.farMat);
    this.far.frustumCulled = false;
    this.scene.add(this.far);
  }

  setQuality(q: Quality) {
    this.quality = q;
    this.level = q === 'low' ? 0 : q === 'high' ? 3 : 2;
    this.applyLevel();
  }

  private applyLevel() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const lv = this.level;
    this.pixelRatio = [Math.min(dpr, 0.75), Math.min(dpr, 1), Math.min(dpr, 1.5), dpr][lv];
    // 中景の横幅を絞ると人数も比例して減る（密度は一定）
    const midW = [90, 130, 190, MID_W_MAX][lv];
    this.midGeo.instanceCount = Math.round((MID_MAX * midW) / MID_W_MAX);
    this.midMat.uniforms.uW.value = midW;
    this.farMat.uniforms.uW.value = midW;
    this.far.geometry.setDrawRange(0, [25000, 50000, 90000, FAR_MAX][lv]);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(this.width, this.height, false);
    this.farMat.uniforms.uScale.value = this.height * this.pixelRatio * 0.9;
  }

  resize(w: number, h: number) {
    this.width = w;
    this.height = h;
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.fov = w < h ? 74 : 60;
    this.camera.updateProjectionMatrix();
    this.farMat.uniforms.uScale.value = h * this.pixelRatio * 0.9;
  }

  /** 自動画質：fps が低ければ段階的に落とす */
  private autoTune(dt: number) {
    if (this.quality !== 'auto' || dt <= 0) return;
    this.fpsAcc += dt;
    this.fpsFrames++;
    if (this.fpsAcc < 2) return;
    const fps = this.fpsFrames / this.fpsAcc;
    this.fpsAcc = 0;
    this.fpsFrames = 0;
    if (fps < 40 && this.level > 0) {
      this.level--;
      this.applyLevel();
    } else if (fps > 58 && this.level < 2) {
      this.level++;
      this.applyLevel();
    }
  }

  onEvents(events: GameEvent[], game: Game) {
    const p = game.player;
    for (const e of events) {
      if (e.type === 'npcFall' || e.type === 'playerFall') {
        const dz = e.z - p.z;
        if (dz > -4 && dz < 26 && Math.abs(e.x - p.x) < 9) this.spawnWord(e.x, e.z, e.type === 'playerFall');
        this.spawnDust(e.x, e.z + 0.5, e.type === 'playerFall' ? 8 : 4);
        if (e.type === 'playerFall') this.shake = 0.5;
      } else if (e.type === 'bump' || e.type === 'trip') {
        this.shake = Math.max(this.shake, e.type === 'trip' ? 0.3 : 0.12);
      } else if (e.type === 'land') {
        this.spawnDust(p.x, p.z, 3);
      }
    }
  }

  private spawnWord(x: number, z: number, big: boolean) {
    const f = this.fxSprites.find((f) => f.t <= 0) ?? this.fxSprites[0];
    f.s.material.map = this.fxTex[Math.floor(Math.random() * this.fxTex.length)];
    f.s.material.needsUpdate = true;
    f.s.position.set(-x, 1.6, z);
    const sc = big ? 1.6 : 1.1;
    f.s.scale.set(sc * 2, sc, 1);
    f.s.visible = true;
    f.t = 0.9;
    f.vy = 1.2;
  }

  private spawnDust(x: number, z: number, n: number) {
    for (let i = 0; i < n; i++) {
      const d = this.dust.find((d) => d.t <= 0);
      if (!d) return;
      d.t = 0.6;
      d.vx = (Math.random() - 0.5) * 2;
      d.vz = (Math.random() - 0.5) * 2;
      d.s.position.set(-x, 0.2, z);
      d.s.visible = true;
    }
  }

  private poseNpc(n: Game['npcs'][number], pose: Pose) {
    pose.x = n.x;
    pose.z = n.z;
    pose.y = 0;
    pose.yaw = Math.atan2(-n.vx, Math.max(0.5, n.v)) * 0.6;
    const running = Math.min(1, n.v / 2.5);
    pose.swing = Math.sin(n.phase * 2.2) * 0.75 * running;
    pose.bob = Math.abs(Math.cos(n.phase * 2.2)) * 0.05 * running;
    pose.lean = 0.12 * running;
    pose.roll = 0;
    pose.armUp = 0;
    pose.fall = 0;
    if (n.state === NState.Stumble) {
      pose.roll = Math.sin(this.clock * 22 + n.id) * 0.35;
      pose.lean = 0.35;
      pose.armUp = 0.7;
    } else if (n.state === NState.Fallen) {
      pose.fall = 1;
      pose.swing = Math.sin(this.clock * 10 + n.id) * 0.15;
      pose.yaw = -n.fallDir * 0.8;
      pose.bob = 0;
      pose.lean = 0;
    } else if (n.state === NState.Getup) {
      pose.fall = Math.max(0, n.t / 0.65);
      pose.yaw = -n.fallDir * 0.8 * pose.fall;
      pose.bob = 0;
    }
  }

  render(game: Game, dt: number) {
    this.clock += dt;
    this.autoTune(dt);
    const p = game.player;
    const pose: Pose = { x: 0, y: 0, z: 0, yaw: 0, fall: 0, roll: 0, swing: 0, armUp: 0, lean: 0, bob: 0 };

    // 近景
    let count = 0;
    let warn = 0;
    let hz = 0;
    for (const n of game.npcs) {
      if (!n.active) continue;
      this.poseNpc(n, pose);
      partMatrices(pose, this.tmpMats);
      for (let k = 0; k < this.near.length; k++) this.near[k].setMatrixAt(count, this.tmpMats[k]);
      this.near[P_HAT].setColorAt(count, HAT_COLORS[n.hat]);
      _c.copy(SHIRT).offsetHSL(0, 0, -n.tint * 0.06);
      this.near[P_TORSO].setColorAt(count, _c);
      _m.makeTranslation(-n.x, 0.01, n.z + pose.fall * 0.45);
      this.nearShadow.setMatrixAt(count, _m);
      count++;
      if (n.state === NState.Stumble && warn < this.warnSprites.length) {
        const s = this.warnSprites[warn++];
        s.visible = true;
        s.position.set(-n.x, 1.75 + Math.sin(this.clock * 20) * 0.05, n.z);
      }
      if (n.state === NState.Fallen) {
        const k = 1 + Math.sin(this.clock * 12) * 0.08;
        _m.makeScale(k, 1, k).setPosition(-(n.x + n.fallDir * 0.3), 0.015, n.z + 0.45);
        this.hazard.setMatrixAt(hz++, _m);
      }
    }
    for (let i = warn; i < this.warnSprites.length; i++) this.warnSprites[i].visible = false;
    for (const m of this.near) {
      m.count = count;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
    this.nearShadow.count = count;
    this.nearShadow.instanceMatrix.needsUpdate = true;
    this.hazard.count = hz;
    this.hazard.instanceMatrix.needsUpdate = true;

    // プレイヤー
    pose.x = p.x;
    pose.z = p.z;
    pose.y = p.y;
    pose.yaw = Math.atan2(-p.vx, Math.max(1, p.v)) * 0.5;
    const run = Math.min(1, p.v / 4);
    pose.swing = Math.sin(p.phase * 2.2) * 0.9 * run;
    pose.bob = Math.abs(Math.cos(p.phase * 2.2)) * 0.06 * run;
    pose.lean = 0.18 * run + (p.dashing ? 0.12 : 0);
    pose.roll = p.wobble > 0 ? Math.sin(this.clock * 30) * 0.25 * p.wobble : 0;
    pose.armUp = p.hopT > 0 ? 0.5 : p.wobble * 0.5;
    pose.fall = 0;
    if (p.state === PState.Fallen) {
      pose.fall = 1;
      pose.swing = 0.2;
      pose.bob = 0;
      pose.lean = 0;
    } else if (p.state === PState.Getup) {
      pose.fall = p.t / 0.45;
    }
    partMatrices(pose, this.playerMats);
    const blink = p.iframe > 0 && p.state === PState.Run && Math.floor(this.clock * 16) % 2 === 0;
    for (let k = 0; k < this.playerParts.length; k++) {
      this.playerParts[k].matrix.copy(this.playerMats[k]);
      this.playerParts[k].visible = !blink;
    }
    this.playerShadow.position.set(-p.x, 0.012, p.z);
    this.playerShadow.scale.setScalar(1.2 - p.y);
    this.playerRing.position.set(-p.x, 0.02, p.z);
    this.playerRing.scale.setScalar(1 + Math.sin(this.clock * 6) * 0.08);
    this.playerMarker.position.set(-p.x, 2.1 + p.y + Math.sin(this.clock * 5) * 0.1, p.z);
    this.playerMarker.rotation.y = this.clock * 2;

    // 中景・遠景（GPU）
    const running = game.started ? 1 : 0;
    for (const mat of [this.midMat, this.farMat]) {
      const u = mat.uniforms;
      u.uTime.value = this.clock;
      u.uRun.value = running;
      u.uFront.value = game.front;
      u.uBack.value = game.back;
      u.uPx.value = -p.x;
      u.uPz.value = p.z;
    }

    // プレイヤーの横位置に合わせて敷き詰めるもの
    for (const t of this.tiled) t.obj.position.x = Math.round(-p.x / t.step) * t.step;
    this.goalBanner.position.x = -p.x;

    // エフェクト
    for (const f of this.fxSprites) {
      if (f.t <= 0) continue;
      f.t -= dt;
      f.s.position.y += f.vy * dt;
      f.s.material.opacity = Math.min(1, f.t * 3);
      if (f.t <= 0) f.s.visible = false;
    }
    for (const d of this.dust) {
      if (d.t <= 0) continue;
      d.t -= dt;
      d.s.position.x += d.vx * dt;
      d.s.position.z += d.vz * dt;
      d.s.position.y += 0.6 * dt;
      const k = 1 - d.t / 0.6;
      d.s.scale.setScalar(0.3 + k * 0.9);
      d.s.material.opacity = d.t / 0.6;
      if (d.t <= 0) d.s.visible = false;
    }

    // カメラ（追従）。高めの位置から群衆の海を見渡す
    const portrait = this.width < this.height;
    const camH = portrait ? 7.2 : 5.8;
    const back = portrait ? 7.6 : 7.2;
    this.camPos.lerp(_v.set(-p.x, camH, p.z - back), 1 - Math.exp(-dt * 8));
    this.camLook.lerp(_v.set(-p.x, 0.4, p.z + (portrait ? 10 : 12)), 1 - Math.exp(-dt * 10));
    this.shake = Math.max(0, this.shake - dt);
    const sh = this.shake * 0.25;
    this.camera.position.set(this.camPos.x + (Math.random() - 0.5) * sh, this.camPos.y + (Math.random() - 0.5) * sh, this.camPos.z);
    this.camera.lookAt(this.camLook);

    this.renderer.render(this.scene, this.camera);
  }

  /**
   * シェア用の写真：プレイヤーの正面から、後ろに続く大群衆ごと撮る。
   * WebGL の描画直後に同じタスク内でコピーするので preserveDrawingBuffer は不要。
   */
  snapshot(game: Game, w = 1200, h = 630): HTMLCanvasElement {
    const p = game.player;
    const cam = new THREE.PerspectiveCamera(48, w / h, 0.1, 1600);
    cam.position.set(-p.x - 1.6, 3.6, p.z + 5.6);
    cam.lookAt(-p.x + 0.7, 0.7, p.z - 7);
    const ratio = this.renderer.getPixelRatio();
    const uScale = this.farMat.uniforms.uScale.value;
    this.playerMarker.visible = false;
    this.playerRing.visible = false;
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(w, h, false);
    this.farMat.uniforms.uScale.value = h * 0.9;
    this.renderer.render(this.scene, cam);
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    out.getContext('2d')!.drawImage(this.renderer.domElement, 0, 0, w, h);
    this.playerMarker.visible = true;
    this.playerRing.visible = true;
    this.farMat.uniforms.uScale.value = uScale;
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(this.width, this.height, false);
    return out;
  }

  /** リトライ時にカメラを即座に移動 */
  snapCamera(game: Game) {
    const p = game.player;
    const portrait = this.width < this.height;
    this.camPos.set(-p.x, portrait ? 7.2 : 5.8, p.z - 7.4);
    this.camLook.set(-p.x, 0.4, p.z + 11);
    for (const f of this.fxSprites) {
      f.t = 0;
      f.s.visible = false;
    }
    for (const d of this.dust) {
      d.t = 0;
      d.s.visible = false;
    }
  }
}
