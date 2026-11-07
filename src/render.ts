/**
 * Three.js による描画。3 段階 LOD：
 *  - 近景：走路内の子ども（パーツ分けした低ポリ人形を InstancedMesh で描画、走り・転倒モーション）
 *  - 中景：柵の外を並走する簡易人型（InstancedMesh、低頻度更新）
 *  - 遠景：地平線まで続く点群（GPU だけで動かす）
 * ゲームの当たり判定は game.ts 側のみ。ここは見た目専用。
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { COURSE, Game, HALF_W, NState, PState, type GameEvent } from './game';

export type Quality = 'low' | 'auto' | 'high';

const SKY = 0xbfe3ff;
const HAT_COLORS = [new THREE.Color(0xe63b3b), new THREE.Color(0xf7f7f2), new THREE.Color(0xffc21a)];
const SHIRT = new THREE.Color(0xfbfbf6);

// 子ども人形のパーツ定義（ローカル座標、足元が原点）
interface Part {
  geo: THREE.BufferGeometry;
  color: number;
  instanceColor: boolean;
}

function box(w: number, h: number, d: number, oy: number) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(0, oy, 0);
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

function makeParts(): Part[] {
  const head = new THREE.IcosahedronGeometry(0.155, 1);
  const hat = new THREE.SphereGeometry(0.17, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2);
  const brim = new THREE.CylinderGeometry(0.13, 0.13, 0.02, 10);
  brim.scale(1, 1, 1.2);
  brim.translate(0, 0.0, 0.1);
  const hatGeo = mergeGeometries([hat.toNonIndexed(), brim.toNonIndexed()])!;
  return [
    { geo: box(0.32, 0.36, 0.2, 0), color: 0xffffff, instanceColor: true }, // 胴体（pivot は腰）
    { geo: box(0.33, 0.16, 0.21, 0), color: 0x1f2f6b, instanceColor: false }, // 短パン
    { geo: head, color: 0xf4c9a0, instanceColor: false },
    { geo: hatGeo, color: 0xffffff, instanceColor: true },
    { geo: box(0.11, 0.56, 0.12, -0.28), color: 0xf2c49b, instanceColor: false },
    { geo: box(0.11, 0.56, 0.12, -0.28), color: 0xf2c49b, instanceColor: false },
    { geo: box(0.08, 0.38, 0.08, -0.17), color: 0xf2c49b, instanceColor: false },
    { geo: box(0.08, 0.38, 0.08, -0.17), color: 0xf2c49b, instanceColor: false },
  ];
}

/** 描画用の姿勢 */
interface Pose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  fall: number; // 0=直立, 1=うつ伏せ
  roll: number;
  swing: number; // 足の振り
  armUp: number; // 腕を上げる（よろけ）
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

/** パーツ単位の行列を計算する（InstancedMesh と単体メッシュの両方で使う） */
function partMatrices(pose: Pose, out: THREE.Matrix4[]) {
  // ゲーム座標 x(右+) → three 座標 -x（カメラが +z を向くため）
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

const FX_WORDS = ['どたっ', 'ぽてっ', 'ずてーん', 'ころん', 'べちゃ'];

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
  private playerMarker: THREE.Mesh;
  private tmpMats: THREE.Matrix4[] = [];
  private mid!: THREE.InstancedMesh;
  private midHat!: THREE.InstancedMesh;
  private midData: { x: number; z: number; v: number; ph: number }[] = [];
  private midFrame = 0;
  private far!: THREE.Points;
  private farMat!: THREE.ShaderMaterial;
  private warnSprites: THREE.Sprite[] = [];
  private fxSprites: { s: THREE.Sprite; t: number; vy: number }[] = [];
  private fxTex: THREE.Texture[] = [];
  private dust: { s: THREE.Sprite; t: number; vx: number; vz: number }[] = [];
  private camPos = new THREE.Vector3(0, 5, -7);
  private camLook = new THREE.Vector3(0, 1, 8);
  private shake = 0;
  private clock = 0;
  quality: Quality = 'auto';
  private pixelRatio = 1;
  private fpsAcc = 0;
  private fpsFrames = 0;
  private midCountMax = 1200;
  private farCountMax = 60000;
  private level = 2; // 自動調整レベル 0..3
  private width = 1;
  private height = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene.background = new THREE.Color(SKY);
    this.scene.fog = new THREE.Fog(SKY, 40, 420);
    this.camera = new THREE.PerspectiveCamera(62, 1, 0.1, 900);

    this.scene.add(new THREE.HemisphereLight(0xeaf6ff, 0x6d8f4a, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-30, 60, -20);
    this.scene.add(sun);

    this.buildStadium();

    // 近景の子ども（パーツごとに InstancedMesh）
    const parts = makeParts();
    for (const p of parts) {
      const mat = new THREE.MeshLambertMaterial({ color: p.color });
      const m = new THREE.InstancedMesh(p.geo, mat, Game.POOL);
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
    // 丸影
    const shadowGeo = new THREE.CircleGeometry(0.3, 12);
    shadowGeo.rotateX(-Math.PI / 2);
    const shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22, depthWrite: false });
    this.nearShadow = new THREE.InstancedMesh(shadowGeo, shadowMat, Game.POOL);
    this.nearShadow.frustumCulled = false;
    this.nearShadow.renderOrder = 1;
    this.scene.add(this.nearShadow);
    // 転倒者の危険ゾーン
    const ringGeo = new THREE.RingGeometry(0.42, 0.62, 20);
    ringGeo.rotateX(-Math.PI / 2);
    this.hazard = new THREE.InstancedMesh(
      ringGeo,
      new THREE.MeshBasicMaterial({ color: 0xff3b30, transparent: true, opacity: 0.55, depthWrite: false }),
      Game.POOL,
    );
    this.hazard.frustumCulled = false;
    this.hazard.renderOrder = 2;
    this.scene.add(this.hazard);

    // プレイヤー
    const pColors = [0xff7a1a, 0x1f2f6b, 0xf4c9a0, 0x2fa8ff, 0xf2c49b, 0xf2c49b, 0xf2c49b, 0xf2c49b];
    parts.forEach((p, i) => {
      const mesh = new THREE.Mesh(p.geo, new THREE.MeshLambertMaterial({ color: pColors[i] }));
      mesh.matrixAutoUpdate = false;
      this.playerParts.push(mesh);
      this.scene.add(mesh);
    });
    this.playerShadow = new THREE.Mesh(shadowGeo, shadowMat);
    this.scene.add(this.playerShadow);
    const markerGeo = new THREE.ConeGeometry(0.16, 0.3, 4);
    markerGeo.rotateX(Math.PI);
    this.playerMarker = new THREE.Mesh(markerGeo, new THREE.MeshBasicMaterial({ color: 0x2fa8ff }));
    this.scene.add(this.playerMarker);

    // 前兆「！」
    const warnTex = makeLabelTexture('!', '#ffd400', 64, 'bold 60px sans-serif');
    for (let i = 0; i < 40; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: warnTex, depthTest: false, transparent: true }));
      s.scale.set(0.9, 0.45, 1);
      s.visible = false;
      s.renderOrder = 10;
      this.warnSprites.push(s);
      this.scene.add(s);
    }
    this.fxTex = FX_WORDS.map((w) => makeLabelTexture(w, '#ffffff', 128, 'bold 64px sans-serif', '#ff5a36'));
    for (let i = 0; i < 10; i++) {
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
    for (let i = 0; i < 48; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: dustTex, transparent: true, depthWrite: false }));
      s.visible = false;
      this.dust.push({ s, t: 0, vx: 0, vz: 0 });
      this.scene.add(s);
    }

    this.buildMidCrowd();
    this.buildFarCrowd();
  }

  private buildStadium() {
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(3000, 3000, 60, 60), new THREE.MeshLambertMaterial({ color: 0x7fbf55 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(0, -0.05, 400);
    this.scene.add(ground);

    // 走路（土のトラック）
    const trackLen = COURSE + 40;
    const track = new THREE.Mesh(
      new THREE.PlaneGeometry(HALF_W * 2 + 0.6, trackLen, 1, 70),
      new THREE.MeshLambertMaterial({ color: 0xc9774a }),
    );
    track.rotation.x = -Math.PI / 2;
    track.position.set(0, 0, trackLen / 2 - 15);
    this.scene.add(track);
    const lineMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const laneCount = 6;
    for (let i = 0; i <= laneCount; i++) {
      const x = -HALF_W + (i * HALF_W * 2) / laneCount;
      const l = new THREE.Mesh(new THREE.PlaneGeometry(0.06, trackLen), lineMat);
      l.rotation.x = -Math.PI / 2;
      l.position.set(x, 0.005, trackLen / 2 - 15);
      this.scene.add(l);
    }
    // スタートライン
    const start = new THREE.Mesh(new THREE.PlaneGeometry(HALF_W * 2, 0.12), lineMat);
    start.rotation.x = -Math.PI / 2;
    start.position.set(0, 0.006, -0.3);
    this.scene.add(start);
    // ゴールライン（市松）
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 16;
    const g = c.getContext('2d')!;
    for (let i = 0; i < 32; i++)
      for (let j = 0; j < 2; j++) {
        g.fillStyle = (i + j) % 2 ? '#111' : '#fff';
        g.fillRect(i * 8, j * 8, 8, 8);
      }
    const checker = new THREE.CanvasTexture(c);
    checker.magFilter = THREE.NearestFilter;
    const goal = new THREE.Mesh(new THREE.PlaneGeometry(HALF_W * 2, 0.8), new THREE.MeshBasicMaterial({ map: checker }));
    goal.rotation.x = -Math.PI / 2;
    goal.position.set(0, 0.007, COURSE);
    this.scene.add(goal);
    // ゴールアーチ
    const poleMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    for (const s of [-1, 1]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 4.2, 8), poleMat);
      pole.position.set(s * (HALF_W + 0.5), 2.1, COURSE);
      this.scene.add(pole);
    }
    const bannerTex = makeLabelTexture('GOAL', '#ffffff', 256, 'bold 150px sans-serif', '#c0392b');
    const banner = new THREE.Mesh(
      new THREE.PlaneGeometry(HALF_W * 2 + 1, 1.3),
      new THREE.MeshBasicMaterial({ map: bannerTex, color: 0xffffff, side: THREE.DoubleSide }),
    );
    banner.position.set(0, 3.7, COURSE);
    banner.rotation.y = Math.PI;
    const bannerBack = new THREE.Mesh(new THREE.PlaneGeometry(HALF_W * 2 + 1.1, 1.4), new THREE.MeshBasicMaterial({ color: 0xd8342a }));
    bannerBack.position.set(0, 3.7, COURSE + 0.02);
    bannerBack.rotation.y = Math.PI;
    this.scene.add(bannerBack, banner);
    // ゴールテープ
    const tape = new THREE.Mesh(new THREE.BoxGeometry(HALF_W * 2 + 1, 0.05, 0.02), new THREE.MeshBasicMaterial({ color: 0xff4d6d }));
    tape.position.set(0, 1.0, COURSE);
    this.scene.add(tape);

    // 柵
    const railMat = new THREE.MeshLambertMaterial({ color: 0xf2f2f2 });
    for (const s of [-1, 1]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, trackLen), railMat);
      rail.position.set(s * (HALF_W + 0.45), 0.7, trackLen / 2 - 15);
      this.scene.add(rail);
      const posts = new THREE.InstancedMesh(new THREE.BoxGeometry(0.08, 0.7, 0.08), railMat, Math.ceil(trackLen / 2.5));
      for (let i = 0; i < posts.count; i++) {
        _m.makeTranslation(s * (HALF_W + 0.45), 0.35, -15 + i * 2.5);
        posts.setMatrixAt(i, _m);
      }
      this.scene.add(posts);
    }
    // 距離表示
    for (let d = 10; d < COURSE; d += 10) {
      const tex = makeLabelTexture(`${d}m`, '#ffffff', 128, 'bold 80px sans-serif', '#7a3a1a');
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.0, 1.0), new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
      sign.rotation.x = -Math.PI / 2;
      sign.rotation.z = Math.PI;
      sign.position.set(0, 0.01, d);
      this.scene.add(sign);
      const line = new THREE.Mesh(new THREE.PlaneGeometry(HALF_W * 2, 0.05), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 }));
      line.rotation.x = -Math.PI / 2;
      line.position.set(0, 0.006, d);
      this.scene.add(line);
    }
  }

  /** 中景：柵の外を並走する簡易人型 */
  private buildMidCrowd() {
    const body = box(0.34, 0.9, 0.22, 0.5);
    const head = new THREE.IcosahedronGeometry(0.16, 0);
    head.translate(0, 1.1, 0);
    const setColor = (geo: THREE.BufferGeometry, c: THREE.Color) => {
      const n = geo.getAttribute('position').count;
      const arr = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) c.toArray(arr, i * 3);
      geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
      return geo;
    };
    const geo = mergeGeometries([
      setColor(body.toNonIndexed(), new THREE.Color(0xf4f4ef)),
      setColor(head.toNonIndexed(), new THREE.Color(0xf4c9a0)),
    ])!;
    const hat = new THREE.SphereGeometry(0.17, 6, 4, 0, Math.PI * 2, 0, Math.PI / 2);
    hat.translate(0, 1.14, 0);
    const max = 1600;
    this.mid = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }), max);
    this.midHat = new THREE.InstancedMesh(hat, new THREE.MeshLambertMaterial({ color: 0xffffff }), max);
    this.mid.frustumCulled = this.midHat.frustumCulled = false;
    this.mid.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.midHat.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    let seed = 12345;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < max; i++) {
      const side = i % 2 ? 1 : -1;
      const x = side * (HALF_W + 1.4 + Math.pow(rnd(), 1.6) * 55);
      this.midData.push({ x, z: rnd() * 150 - 15, v: 2.3 + rnd() * 0.8, ph: rnd() * 6.28 });
      this.midHat.setColorAt(i, HAT_COLORS[rnd() < 0.5 ? 0 : 1]);
    }
    this.scene.add(this.mid, this.midHat);
  }

  /** 遠景：地平線まで続く点群（GPU で移動） */
  private buildFarCrowd() {
    const count = 90000;
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const spd = new Float32Array(count);
    let seed = 987654;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < count; i++) {
      const side = rnd() < 0.5 ? -1 : 1;
      const x = side * (HALF_W + 25 + Math.pow(rnd(), 1.3) * 900);
      pos[i * 3] = x;
      pos[i * 3 + 1] = 0;
      pos[i * 3 + 2] = rnd() * 760;
      const c = rnd() < 0.5 ? HAT_COLORS[0] : rnd() < 0.85 ? HAT_COLORS[1] : new THREE.Color(0xf4c9a0);
      c.toArray(col, i * 3);
      spd[i] = 2.2 + rnd() * 0.9;
    }
    // 中心から近い順に並べ替えず、ランダム順なので drawRange を減らすと均等に間引ける
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('speed', new THREE.BufferAttribute(spd, 1));
    this.farMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uCamZ: { value: 0 },
        uScale: { value: 300 },
        uFog: { value: new THREE.Color(SKY) },
      },
      vertexShader: /* glsl */ `
        attribute vec3 color;
        attribute float speed;
        uniform float uTime;
        uniform float uCamZ;
        uniform float uScale;
        varying vec3 vColor;
        varying float vFog;
        void main() {
          vec3 p = position;
          float z0 = uCamZ - 40.0;
          p.z = z0 + mod(p.z + uTime * speed - z0, 760.0);
          p.y = 0.75 + abs(sin(uTime * 9.0 + position.x * 1.7 + position.z)) * 0.12;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          float d = -mv.z;
          gl_PointSize = clamp(uScale * 0.55 / d, 1.0, 9.0);
          vColor = color;
          vFog = smoothstep(60.0, 520.0, d);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uFog;
        varying vec3 vColor;
        varying float vFog;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          if (dot(c, c) > 0.25) discard;
          gl_FragColor = vec4(mix(vColor, uFog, vFog * 0.85), 1.0);
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
    this.midCountMax = [300, 600, 1000, 1600][lv];
    this.farCountMax = [15000, 30000, 60000, 90000][lv];
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(this.width, this.height, false);
    this.far.geometry.setDrawRange(0, this.farCountMax);
    this.mid.count = this.midHat.count = this.midCountMax;
  }

  resize(w: number, h: number) {
    this.width = w;
    this.height = h;
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // 縦持ちでは視野角を広げて前方を見やすくする
    this.camera.fov = w < h ? 72 : 58;
    this.camera.updateProjectionMatrix();
    this.farMat.uniforms.uScale.value = h * this.pixelRatio * 0.9;
  }

  /** 自動画質：fps が低ければ段階的に落とす */
  private autoTune(dt: number) {
    if (this.quality !== 'auto') return;
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
        if (dz > -4 && dz < 26) this.spawnWord(e.x, e.z, e.type === 'playerFall');
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
      const hat = HAT_COLORS[n.hat];
      this.near[P_HAT].setColorAt(count, hat);
      _c.copy(SHIRT);
      if (n.leader) _c.set(0xffd23f);
      else _c.offsetHSL(0, 0, -n.tint * 0.06);
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
    this.playerMarker.position.set(-p.x, 2.0 + p.y + Math.sin(this.clock * 5) * 0.08, p.z);
    this.playerMarker.rotation.y = this.clock * 2;

    // 中景（低頻度更新）
    this.midFrame++;
    if (this.midFrame % 2 === 0 || dt > 0.03) {
      const t = this.clock;
      const camZ = p.z;
      for (let i = 0; i < this.midCountMax; i++) {
        const d = this.midData[i];
        if (game.started && !game.finished) d.z += d.v * dt * (this.midFrame % 2 === 0 ? 2 : 1);
        if (d.z < camZ - 12) d.z += 150;
        else if (d.z > camZ + 140) d.z -= 150;
        const bob = game.started ? Math.abs(Math.sin(t * 9 + d.ph)) * 0.08 : 0;
        _m.makeTranslation(d.x, bob, d.z);
        this.mid.setMatrixAt(i, _m);
        this.midHat.setMatrixAt(i, _m);
      }
      this.mid.instanceMatrix.needsUpdate = true;
      this.midHat.instanceMatrix.needsUpdate = true;
      if (this.midHat.instanceColor) this.midHat.instanceColor.needsUpdate = true;
    }

    // 遠景
    this.farMat.uniforms.uTime.value = game.started ? game.time : 0;
    this.farMat.uniforms.uCamZ.value = p.z;

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

    // カメラ（追従）
    const portrait = this.width < this.height;
    const tx = -p.x * 0.8;
    const camH = portrait ? 5.6 : 4.6;
    const back = portrait ? 6.8 : 6.2;
    this.camPos.lerp(_v.set(tx, camH, p.z - back), 1 - Math.exp(-dt * 8));
    this.camLook.lerp(_v.set(-p.x * 0.75, 0.6, p.z + (portrait ? 9 : 10)), 1 - Math.exp(-dt * 10));
    this.shake = Math.max(0, this.shake - dt);
    const sh = this.shake * 0.25;
    this.camera.position.set(this.camPos.x + (Math.random() - 0.5) * sh, this.camPos.y + (Math.random() - 0.5) * sh, this.camPos.z);
    this.camera.lookAt(this.camLook);

    this.renderer.render(this.scene, this.camera);
  }

  /** リトライ時にカメラを即座に移動 */
  snapCamera(game: Game) {
    const p = game.player;
    this.camPos.set(-p.x * 0.55, 5.4, p.z - 6.6);
    this.camLook.set(-p.x * 0.75, 0.6, p.z + 9);
    for (const f of this.fxSprites) {
      f.t = 0;
      f.s.visible = false;
    }
    for (const d of this.dust) {
      d.t = 0;
      d.s.visible = false;
    }
    for (let i = 0; i < this.midData.length; i++) this.midData[i].z = ((i * 37) % 150) - 15;
  }
}

const _c = new THREE.Color();
