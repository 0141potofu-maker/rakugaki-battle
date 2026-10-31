const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

// ---------- ゲーム設定(サーバーが正) ----------
const TICK = 60;
const DT = 1 / TICK;
const SEND_EVERY = 2; // 2tickごとに送信 = 30回/秒
const MAX_PLAYERS = 4;
const SCALE = 0.8; // 描いた絵の1ピクセル = ゲーム内の0.8

const STAGE = { w: 1800, top: 0, depth: 300, wall: 180 }; // 終点風。上面が y=0、wallは垂直な側面の高さ
const BLAST = { x: 1500, top: -1200, bottom: 900 }; // これを超えたら撃墜
const PHYS = {
  run: 430,
  groundAcc: 3200,
  airAcc: 1800,
  groundFric: 3600,
  airFric: 500,
  gravity: 2600,
  maxFall: 1200,
  jump: 1139,    // ジャンプの高さが約1.5倍になる強さ
  airJump: 1004,
};

const STOCKS = 3;           // 残機
const RESPAWN_FRAMES = 90;  // 撃墜されてから復活するまで(1.5秒)
const INV_FRAMES = 150;     // 復活してからの無敵(2.5秒)

// ---------- プレイヤー ----------
function makePlayer(slot) {
  return {
    slot,
    ws: null,
    active: false, // 絵を出して、試合に参加している
    rig: null,     // 描いた絵(からだ+手足のパーツ)
    hb: [0, 0, 56, 84], // 食らい判定(からだだけ。手足はふくまない)
    limbs: [],     // 手足の大きさ(攻撃判定に使う)
    bw: 56, bh: 84, // キャラの大きさ(ゲーム内)
    area: 0,        // 塗ったピクセル数(体重・速さに使う)
    colors: [0, 0, 0, 0, 0], // 赤・青・黄・白・黒のピクセル数(あとで技に使う)
    weight: 100,    // 体重(重いほど吹っ飛びにくい)
    speedMul: 1,    // 移動の速さの倍率
    gravMul: 1,     // 重力の倍率
    handR: 18,      // 手の大きさ(攻撃判定の大きさになる)
    footR: 18,      // 足の大きさ(攻撃判定の大きさになる)
    colSp: 0,       // 必殺技の色(0赤 1青 2黄 3白 4黒)
    colNm: 0,       // 通常攻撃の色
    airSp: false,   // 空中必殺を使った(着地・崖つかまりで回復)
    fxAcc: [],      // 技の見た目(当たり判定の形)
    x: 0, y: 0, vx: 0, vy: 0,
    f: 1,          // 向き 1=右 -1=左
    g: true,       // 接地
    airJump: false, // 空中ジャンプ使用済み
    prevJ: false,
    prevL: false,
    prevR: false,
    prevA: false,
    prevB: false,
    hang: 0,   // 崖につかまり中: -1=左の崖 1=右の崖 0=なし
    hangT: 0,  // つかまっているフレーム数
    cd: 0,     // 崖につかまれるようになるまでのフレーム数
    dmg: 0,    // 蓄積ダメージ(%)
    stocks: STOCKS,
    life: 0,   // 0=戦っている 1=復活待ち 2=脱落
    respT: 0,  // 復活までのフレーム数
    inv: 0,    // 無敵のフレーム数
    stun: 0,   // のけぞりのフレーム数
    atk: null, // 技を出している間の状態 {mv, t, hit, col, d, end}
    ko: false, // 撃墜されたばかり
    vote: false, // 「もういちど」を押した
    input: { l: 0, r: 0, j: 0, a: 0, b: 0 },
  };
}

// 手足の大きさ(ピクセルの数)から、攻撃判定の半径を決める
const limbR = (a) => Math.max(18, Math.min(72, Math.sqrt(a / Math.PI) * SCALE * 1.4 + 12));

// 面積から体重・速さ、手足の大きさから攻撃判定の大きさ、色の割合から技を決める
function applyBody(p) {
  const lo = Math.log(400);
  const hi = Math.log(40000);
  const t = Math.max(0, Math.min(1, (Math.log(Math.max(p.area, 1)) - lo) / (hi - lo)));
  p.weight = 70 + 70 * t;          // 70(軽い)〜140(重い)
  p.speedMul = 1.35 - 0.65 * t;    // 1.35(速い)〜0.7(遅い)
  p.gravMul = 0.92 + 0.2 * t;      // 重いほど速く落ちる

  const biggest = (k) => {
    const v = p.limbs.filter((l) => l.k === k).map((l) => l.a);
    return v.length ? Math.max(...v) : 0;
  };
  const ha = biggest('h');
  const fa = biggest('f');
  p.handR = ha ? limbR(ha) : 18;
  p.footR = fa ? limbR(fa) : 18;

  // いちばん多い色が必殺技、2番目に多い色が通常攻撃(同じ数なら 赤→青→黄→白→黒 の順)
  const order = [0, 1, 2, 3, 4].sort((x, y) => p.colors[y] - p.colors[x] || x - y);
  p.colSp = order[0];
  p.colNm = p.colors[order[1]] > 0 ? order[1] : order[0];
}

function resetFighter(p) {
  p.dmg = 0;
  p.stocks = STOCKS;
  p.life = 0;
  p.respT = 0;
  p.inv = 0;
  p.vote = false;
}

function spawn(p, fromAir) {
  p.x = -300 + p.slot * 200;
  p.y = fromAir ? -450 : STAGE.top;
  p.vx = 0;
  p.vy = 0;
  p.g = !fromAir;
  p.airJump = false;
  p.prevJ = false;
  p.prevL = false;
  p.prevR = false;
  p.prevA = false;
  p.prevB = false;
  p.airSp = false;
  p.fxAcc = [];
  p.hang = 0;
  p.hangT = 0;
  p.cd = 0;
  p.stun = 0;
  p.atk = null;
  p.ko = false;
}

function respawn(p) {
  spawn(p, true);
  p.dmg = 0;
  p.inv = INV_FRAMES;
  p.life = 0;
}

// 撃墜されたとき
function koPlayer(r, p, events) {
  p.ko = false;
  events.push({
    k: 'ko',
    x: Math.max(-BLAST.x, Math.min(BLAST.x, p.x)),
    y: Math.max(BLAST.top, Math.min(BLAST.bottom, p.y)),
  });
  if (r.versus) p.stocks--;
  p.hang = 0;
  p.atk = null;
  p.stun = 0;
  p.vx = 0;
  p.vy = 0;
  if (p.stocks > 0 || !r.versus) {
    p.life = 1;
    p.respT = RESPAWN_FRAMES;
  } else {
    p.life = 2; // 残機がなくなった
  }
}

// ---------- 当たり判定 ----------
// 食らい判定(からだだけ。手足はふくまない)。左向きのときは左右反転
function hurtRect(p) {
  const hx = p.hb[0], hy = p.hb[1], hw = p.hb[2], hh = p.hb[3];
  const x0 = p.f >= 0 ? p.x - p.bw / 2 + hx : p.x + p.bw / 2 - hx - hw;
  const y0 = p.y - p.bh + hy;
  return { x0, y0, x1: x0 + hw, y1: y0 + hh };
}

function circleHitsRect(cx, cy, R, r) {
  const nx = Math.max(r.x0, Math.min(cx, r.x1));
  const ny = Math.max(r.y0, Math.min(cy, r.y1));
  return (cx - nx) ** 2 + (cy - ny) ** 2 <= R * R;
}

// 形(円 または 四角)が、食らい判定の四角に当たっているか
function shapeHitsRect(sh, r) {
  if (sh.k === 'c') return circleHitsRect(sh.x, sh.y, sh.r, r);
  return !(sh.x1 < r.x0 || sh.x0 > r.x1 || sh.y1 < r.y0 || sh.y0 > r.y1);
}

// 当たったときに、エフェクトを出す場所
function hitPoint(sh, q) {
  if (sh.k === 'c') return { x: sh.x, y: sh.y, cx: sh.x };
  return {
    x: Math.max(sh.x0, Math.min(q.x, sh.x1)),
    y: Math.max(sh.y0, Math.min(q.y - q.bh * 0.5, sh.y1)),
    cx: (sh.x0 + sh.x1) / 2,
  };
}

// 攻撃が当たったとき: ダメージを増やして、吹っ飛ばす
// h = {dmg, bkb(基本の強さ), kbg(ダメージによる増え方), ang(角度。上が正、下が負)}
function applyHit(att, tgt, hx, hy, h, events, o) {
  tgt.dmg = Math.min(999, tgt.dmg + h.dmg);
  const kb = Math.min(1800, h.bkb + tgt.dmg * h.kbg * (100 / tgt.weight)); // ダメージが多いほど、軽いほど飛ぶ
  const ang = (h.ang * Math.PI) / 180;
  if (o.carry) {
    // 連続ヒット: 相手を技の動きに引きつける
    tgt.vx = o.carry.vx;
    tgt.vy = o.carry.vy;
    tgt.stun = 6;
  } else {
    const dirX = o.dirX !== undefined ? o.dirX : att.f;
    tgt.vx = dirX * kb * Math.cos(ang);
    tgt.vy = -kb * Math.sin(ang);
    tgt.stun = Math.min(70, Math.floor(kb / 18));
  }
  tgt.g = false;
  tgt.hang = 0;
  tgt.atk = null;
  events.push({ k: 'hit', x: +hx.toFixed(1), y: +hy.toFixed(1), c: o.col });
}

// ---------- 技 ----------
// 技の名前は「色 + 通常n/必殺s + 地上g/空中a」。例: rng=赤の通常・地上、ksa=黒の必殺・空中
const COLOR_KEYS = ['r', 'b', 'y', 'w', 'k'];
const H = (dmg, bkb, kbg, ang) => ({ dmg, bkb, kbg, ang });
const JAB = H(1, 70, 0, 25); // 連続ヒットの、1発ごとの弱い当たり

function pickR(p, type) {
  if (type === 'h') return p.handR;
  if (type === 'f') return p.footR;
  return Math.max(p.handR, p.footR);
}

const circ = (x, y, r) => ({ k: 'c', x, y, r });
const rect = (x0, y0, x1, y1) => ({ k: 'r', x0, y0, x1, y1 });
const frontX = (p, k) => p.x + p.f * (p.bw / 2 + k); // からだの前
const midY = (p) => p.y - p.bh * 0.55;                // 胸の高さ
const inWin = (t, from, len) => t > from && t <= from + len; // fromの次のフレームから、len フレームのあいだ

// 形を、見た目用の短い配列にする([0,x,y,r,色] か [1,x0,y0,x1,y1,色])
function packShape(sh, col) {
  const q = (v) => Math.round(v);
  return sh.k === 'c' ? [0, q(sh.x), q(sh.y), q(sh.r), col] : [1, q(sh.x0), q(sh.y0), q(sh.x1), q(sh.y1), col];
}

// 技の中から使う道具(当たり判定を出す・弾を出す)
function makeFx(p, env) {
  const a = p.atk;
  return {
    hit(id, shape, h, o) {
      o = o || {};
      p.fxAcc.push(packShape(shape, a.col));
      if (p.fxAcc.length > 10) p.fxAcc.shift();
      for (const q of env.others) {
        if (q === p || q.life !== 0 || q.inv > 0 || q.hang) continue;
        const key = q.slot + ':' + id; // 同じ技で、同じ相手には1つの id につき1回だけ当たる
        if (a.hit.includes(key)) continue;
        if (!shapeHitsRect(shape, hurtRect(q))) continue;
        a.hit.push(key);
        const pt = hitPoint(shape, q);
        applyHit(p, q, pt.x, pt.y, h, env.events, {
          dirX: o.away ? (q.x >= pt.cx ? 1 : -1) : p.f,
          carry: o.carry,
          col: a.col,
        });
      }
    },
    proj(o) {
      env.projs.push(Object.assign({ owner: p.slot, col: a.col, life: 60 }, o));
    },
  };
}

// 決まった時間のあいだ、当たり判定が出る近接技
function melee(o) {
  return {
    style: o.style, total: o.total, lockJump: o.lockJump, ctl: o.ctl,
    act(p, t, fx) {
      if (inWin(t, o.startup, o.active)) fx.hit('a', o.shape(p, pickR(p, o.r)), o.hit, o.opt);
      if (o.post) o.post(p, t);
    },
  };
}

// 白: 連続ヒットで上昇(地上は最後に吹き飛ばす)
function rise(ground) {
  return {
    style: 'rise', total: ground ? 62 : 56, lockJump: true,
    ctl: (p, t) => (t <= 8 ? { vx: 0, vy: 0 } : t <= 44 ? { vx: 0, vy: -540 } : null),
    act(p, t, fx) {
      const R = pickR(p, 'hf');
      if (t > 8 && t <= 44 && (t - 9) % 4 === 0) {
        fx.hit('m' + t, circ(p.x + p.f * p.bw * 0.2, p.y - p.bh * 0.55, R * 0.9 + p.bh * 0.25), JAB, { carry: { vx: 0, vy: -540 } });
      }
      if (t >= 45 && t <= 52) {
        fx.hit('fin', circ(p.x + p.f * R * 0.2, p.y - p.bh * 0.4, R * 1.2 + p.bh * 0.45), ground ? H(5, 420, 12, 70) : H(2, 250, 6, 80), { away: true });
      }
    },
  };
}

const MOVES = {
  // ===== 赤(火) =====
  // 通常・地上: 火のパンチ
  rng: melee({
    style: 'punch', total: 24, startup: 5, active: 6, r: 'h',
    shape: (p, R) => circ(frontX(p, R * 0.5), midY(p), R), hit: H(8, 300, 10, 40),
  }),
  // 通常・空中: 火を纏って回転
  rna: melee({
    style: 'spin', total: 34, startup: 4, active: 24, r: 'hf',
    shape: (p, R) => circ(p.x, p.y - p.bh / 2, Math.max(p.bw, p.bh) / 2 + R * 0.5),
    hit: H(9, 280, 10, 50), opt: { away: true },
  }),
  // 必殺・地上: 火を纏って突進
  rsg: melee({
    style: 'dash', total: 42, lockJump: true, startup: 8, active: 18, r: 'hf',
    ctl: (p, t) => (t <= 8 ? { vx: 0 } : t <= 26 ? { vx: p.f * 880 } : null),
    shape: (p, R) => circ(frontX(p, R * 0.2), p.y - p.bh * 0.5, R * 0.9 + p.bh * 0.25),
    hit: H(12, 380, 13, 35),
  }),
  // 必殺・空中: 火を纏って上昇
  rsa: melee({
    style: 'up', total: 44, lockJump: true, startup: 6, active: 24, r: 'hf',
    ctl: (p, t) => (t <= 6 ? { vx: 0, vy: 0 } : t <= 30 ? { vx: p.f * 120, vy: -880 } : null),
    shape: (p, R) => circ(p.x, p.y - p.bh * 0.5, p.bh * 0.5 + R * 0.4),
    hit: H(10, 350, 11, 80), opt: { away: true },
  }),

  // ===== 青(水) =====
  // 通常・地上: 水のキック
  bng: melee({
    style: 'kick', total: 26, startup: 7, active: 7, r: 'f',
    shape: (p, R) => circ(frontX(p, R * 0.5), p.y - p.bh * 0.25, R), hit: H(8, 300, 10, 35),
  }),
  // 通常・空中: メテオ(下に叩きつける)
  bna: melee({
    style: 'kickdown', total: 32, startup: 9, active: 9, r: 'f',
    shape: (p, R) => circ(p.x + p.f * p.bw * 0.1, p.y + R * 0.2, R), hit: H(10, 240, 8, -75),
  }),
  // 必殺・地上: 水の弾を飛ばす
  bsg: {
    style: 'shoot', total: 34,
    act(p, t, fx) {
      if (t === 10) {
        const R = pickR(p, 'h');
        fx.proj({ x: frontX(p, R * 0.5), y: midY(p), vx: p.f * 720, vy: 0, r: R * 0.7 + 8, life: 70, hit: H(9, 260, 9, 30), dx: p.f });
      }
    },
  },
  // 必殺・空中: 水の弾を下に飛ばして、その反動で上昇
  bsa: {
    style: 'shootdown', total: 40, lockJump: true,
    ctl: (p, t) => (t >= 8 && t <= 11 ? { vy: -780 } : null),
    act(p, t, fx) {
      if (t === 8) {
        const R = pickR(p, 'h');
        fx.proj({ x: p.x, y: p.y - p.bh * 0.2, vx: 0, vy: 800, r: R * 0.7 + 8, life: 45, hit: H(7, 200, 8, -65), dx: p.f });
      }
    },
  },

  // ===== 黄(雷) =====
  // 通常・地上: 少し前進しながら雷のキック
  yng: melee({
    style: 'kick', total: 28, startup: 6, active: 8, r: 'f',
    ctl: (p, t) => (t > 5 && t <= 15 ? { vx: p.f * 320 } : null),
    shape: (p, R) => circ(frontX(p, R * 0.5), p.y - p.bh * 0.25, R), hit: H(8, 300, 10, 40),
  }),
  // 通常・空中: 上に雷を放つ
  yna: melee({
    style: 'up', total: 30, startup: 7, active: 7, r: 'h',
    shape: (p, R) => {
      const w = Math.max(p.bw * 0.9, R * 2 + 10);
      return rect(p.x - w / 2, p.y - p.bh - 170, p.x + w / 2, p.y - p.bh * 0.4);
    },
    hit: H(9, 300, 10, 85), opt: { away: true },
  }),
  // 必殺・地上: 左右の地面に落雷
  ysg: {
    style: 'charge', total: 52,
    act(p, t, fx) {
      const a = p.atk;
      if (t === 14) {
        const D = p.bw / 2 + 130;
        a.d.xs = [p.x - D, p.x + D];
      }
      if (t > 14 && t <= 22 && a.d.xs) {
        const w = 60 + pickR(p, 'hf') * 0.6;
        a.d.xs.forEach((x, i) => fx.hit('s' + i, rect(x - w / 2, p.y - 420, x + w / 2, p.y + 8), H(11, 330, 11, 70), { away: true }));
      }
    },
  },
  // 必殺・空中: 向いている方向の斜め上に、高速で突進
  ysa: melee({
    style: 'dash', total: 36, lockJump: true, startup: 6, active: 16, r: 'hf',
    ctl: (p, t) => (t <= 6 ? { vx: 0, vy: 0 } : t <= 22 ? { vx: p.f * 620, vy: -620 } : null),
    shape: (p, R) => circ(p.x + p.f * p.bw * 0.25, p.y - p.bh * 0.5, R * 0.9 + p.bh * 0.25),
    hit: H(9, 320, 10, 45),
    post: (p, t) => { if (t === 23) { p.vx *= 0.4; p.vy *= 0.4; } },
  }),

  // ===== 白(連続ヒット) =====
  // 通常・地上: 連続パンチ
  wng: {
    style: 'rapid', total: 46,
    act(p, t, fx) {
      const R = pickR(p, 'h');
      for (let k = 0; k < 5; k++) {
        if (t >= 5 + 5 * k && t <= 7 + 5 * k) fx.hit('j' + k, circ(frontX(p, R * 0.5), midY(p), R), JAB);
      }
      if (t >= 32 && t <= 36) fx.hit('fin', circ(frontX(p, R * 0.7), midY(p), R * 1.1), H(3, 300, 8, 40));
    },
  },
  // 通常・空中: 連続ヒットの急降下
  wna: {
    style: 'dive', total: 44, lockJump: true,
    ctl: (p, t) => {
      const d = p.atk.d;
      if (d.landed) return { vx: 0 };
      if (t < 8) return { vx: 0, vy: 0 };
      if (t <= 34) return { vx: p.f * 140, vy: 1000 };
      return null;
    },
    act(p, t, fx) {
      const a = p.atk;
      const d = a.d;
      const R = pickR(p, 'f');
      if (!d.landed && t >= 8 && t <= 34) {
        if (p.g) {
          d.landed = true; // 着地したら、最後の一撃
          fx.hit('fin', circ(p.x + p.f * R * 0.3, p.y - R * 0.4, R * 1.2), H(3, 300, 8, 55));
          a.end = t + 10;
        } else if ((t - 8) % 4 === 0) {
          fx.hit('m' + t, circ(p.x + p.f * p.bw * 0.15, p.y - p.bh * 0.1, R + 10), JAB, { carry: { vx: 0, vy: 900 } });
        }
      }
    },
  },
  // 必殺・地上: 連続ヒットで上昇して、最後に吹き飛ばす
  wsg: rise(true),
  // 必殺・空中: 連続ヒットで上昇
  wsa: rise(false),

  // ===== 黒(溜め・重い一撃) =====
  // 通常・地上: アッパー
  kng: melee({
    style: 'upper', total: 30, startup: 6, active: 7, r: 'h',
    shape: (p, R) => circ(frontX(p, R * 0.3), p.y - p.bh * 0.85, R * 1.1), hit: H(9, 330, 11, 80),
  }),
  // 通常・空中: 向いている方向に蹴る
  kna: melee({
    style: 'kick', total: 28, startup: 7, active: 7, r: 'f',
    shape: (p, R) => circ(frontX(p, R * 0.5), p.y - p.bh * 0.35, R * 1.05), hit: H(9, 320, 11, 30),
  }),
  // 必殺・地上: 溜めてパンチ(約1秒溜める)
  ksg: {
    style: 'punch', chargeT: 60, total: 80, lockJump: true,
    ctl: (p, t) => (t <= 60 ? { vx: 0 } : null),
    act(p, t, fx) {
      if (inWin(t, 60, 12)) {
        const R = pickR(p, 'h');
        fx.hit('a', circ(frontX(p, R * 0.6), midY(p), R * 1.3 + 10), H(20, 450, 16, 35));
      }
    },
  },
  // 必殺・空中: 溜めて横に突進(約1秒溜める)
  ksa: {
    style: 'dash', chargeT: 60, total: 90, lockJump: true,
    ctl: (p, t) => (t <= 60 ? { vx: 0, vy: 100 } : t <= 76 ? { vx: p.f * 1000, vy: 0 } : null),
    act(p, t, fx) {
      if (inWin(t, 60, 16)) {
        const R = pickR(p, 'hf');
        fx.hit('a', circ(p.x + p.f * p.bw * 0.25, p.y - p.bh * 0.5, R + p.bh * 0.3), H(16, 420, 14, 35));
      }
      if (t === 77) p.vx *= 0.3;
    },
  },
};

// 技のアニメーション用: 今の動きの名前と、その動きの中での進みぐあい(溜めのある技は、溜めと攻撃を別々に数える)
function animOf(a) {
  const mv = a.mv;
  const t = a.t;
  if (!mv.chargeT) return { ms: mv.style, at: t, tt: mv.total };
  if (t <= mv.chargeT) return { ms: 'charge', at: t, tt: mv.chargeT };
  return { ms: mv.style, at: t - mv.chargeT, tt: mv.total - mv.chargeT };
}

// 技を始める(special=必殺か)。始められなければ false
function startAttack(p, special) {
  const air = !p.g;
  if (special && air) {
    if (p.airSp) return false; // 空中必殺は、着地するまで1回だけ
    p.airSp = true;
  }
  const col = special ? p.colSp : p.colNm;
  const key = COLOR_KEYS[col] + (special ? 's' : 'n') + (air ? 'a' : 'g');
  p.atk = { mv: MOVES[key], t: 0, hit: [], col, key, d: {}, end: 0 };
  return true;
}

// 弾(水の弾など)を動かして、当たったら吹っ飛ばす
function stepProjectiles(r, alive) {
  for (let i = r.projs.length - 1; i >= 0; i--) {
    const b = r.projs[i];
    b.x += b.vx * DT;
    b.y += b.vy * DT;
    b.life--;
    let dead = b.life <= 0 || Math.abs(b.x) > BLAST.x + 200 || b.y > BLAST.bottom + 200 || b.y < BLAST.top - 200;
    // 下向きの弾は、ステージにぶつかって消える
    if (!dead && b.vy > 0 && Math.abs(b.x) <= STAGE.w / 2 && b.y + b.r >= STAGE.top) dead = true;
    if (!dead) {
      for (const q of alive) {
        if (q.slot === b.owner || q.life !== 0 || q.inv > 0 || q.hang) continue;
        if (circleHitsRect(b.x, b.y, b.r, hurtRect(q))) {
          applyHit({ f: b.dx }, q, b.x, b.y, b.hit, r.events, { dirX: b.dx, col: b.col });
          dead = true;
          break;
        }
      }
    }
    if (dead) r.projs.splice(i, 1);
  }
}

// ---------- 動き ----------
// 崖(ステージのかど)につかまっている間の動き
function hangUpdate(p, pL, pR, pJ) {
  const s = p.hang; // -1=左の崖 1=右の崖
  const half = STAGE.w / 2;
  p.hangT++;
  p.vx = 0;
  p.vy = 0;
  p.x = s * (half + p.bw / 2);
  p.y = STAGE.top + p.bh + 6;
  p.f = -s; // ステージのほうを向く
  if (p.hangT < 12) return; // つかまった直後は少しの間、操作できない

  const toStage = s < 0 ? pR : pL; // ステージ側へ押す
  const away = s < 0 ? pL : pR;    // 反対側へ押す
  if (pJ) {
    // 飛び上がる
    p.hang = 0;
    p.cd = 30;
    p.vy = -PHYS.jump;
    p.vx = -s * 160;
    p.g = false;
  } else if (toStage) {
    // ステージにのぼる
    p.hang = 0;
    p.x = s * (half - p.bw / 2 - 6);
    p.y = STAGE.top;
    p.vx = 0;
    p.vy = 0;
    p.g = true;
    p.airJump = false;
    p.airSp = false;
  } else if (away || p.hangT > 300) {
    // はなす(つかまりつづけると5秒で自動ではなれる)
    p.hang = 0;
    p.cd = 40;
    p.vx = s * 80;
    p.g = false;
  }
}

// 崖につかまれるか調べる
function tryGrab(p, occ) {
  if (p.g || p.vy < 0 || p.cd > 0 || p.stun > 0) return;
  const s = p.x < 0 ? -1 : 1;
  if (p.f !== -s) return; // ステージのほうを向いているときだけ
  if (occ[s] !== undefined && occ[s] !== p.slot) return; // 先に誰かがつかまっている
  const half = STAGE.w / 2;
  const dy = p.y - p.bh - STAGE.top;          // 頭が崖の上面よりどれだけ下か
  const out = s * (p.x - (s * p.bw) / 2) - half; // 体のステージ側のはしが、かどより外へどれだけ出ているか
  if (dy < -20 || dy > 100 || out < -25 || out > 50) return;
  p.hang = s;
  p.hangT = 0;
  p.airJump = false; // つかまると空中ジャンプと空中必殺が回復
  p.airSp = false;
  p.atk = null;
  p.vx = 0;
  p.vy = 0;
  occ[s] = p.slot;
}

function step(p, occ, env) {
  const i = p.input;
  const pL = i.l && !p.prevL; // 押した瞬間
  const pR = i.r && !p.prevR;
  const pJ = i.j && !p.prevJ;
  const pA = i.a && !p.prevA;
  const pB = i.b && !p.prevB;
  p.prevL = !!i.l;
  p.prevR = !!i.r;
  p.prevJ = !!i.j;
  p.prevA = !!i.a;
  p.prevB = !!i.b;
  if (p.cd > 0) p.cd--;
  if (p.inv > 0) p.inv--;

  if (p.hang) {
    hangUpdate(p, pL, pR, pJ);
    return;
  }

  const stunned = p.stun > 0;
  if (stunned) p.stun--;

  // 技を始める(のけぞり中はできない)。必殺ボタンが優先
  if (!stunned && !p.atk) {
    if (pB) startAttack(p, true);
    else if (pA) startAttack(p, false);
  }

  // 技による動きの指定(速さを直接きめる技がある)
  let ctl = null;
  if (p.atk) {
    p.atk.t++;
    if (p.atk.mv.ctl) ctl = p.atk.mv.ctl(p, p.atk.t) || null;
  }
  const lockJump = !!(p.atk && p.atk.mv.lockJump);

  // 左右移動(地上で技を出している間・のけぞり中は動けない)
  const dir = stunned || (p.atk && p.g) ? 0 : (i.r ? 1 : 0) - (i.l ? 1 : 0);
  const maxRun = PHYS.run * p.speedMul;
  if (ctl && ctl.vx !== undefined) {
    p.vx = ctl.vx;
  } else if (dir) {
    if (!p.atk) p.f = dir;
    const acc = p.g ? PHYS.groundAcc : PHYS.airAcc;
    const target = dir * maxRun;
    if (p.vx < target) p.vx = Math.min(target, p.vx + acc * DT);
    else p.vx = Math.max(target, p.vx - acc * DT);
  } else {
    const fr = p.g ? PHYS.groundFric : stunned ? 220 : PHYS.airFric;
    if (p.vx > 0) p.vx = Math.max(0, p.vx - fr * DT);
    else p.vx = Math.min(0, p.vx + fr * DT);
  }

  // ジャンプ(押した瞬間だけ)
  if (!stunned && pJ && !lockJump) {
    if (p.g) {
      p.vy = -PHYS.jump;
      p.g = false;
    } else if (!p.airJump) {
      p.vy = -PHYS.airJump;
      p.airJump = true;
    }
  }

  // 移動
  const prevY = p.y;
  if (ctl && ctl.vy !== undefined) {
    p.vy = ctl.vy;
    if (ctl.vy < 0) p.g = false;
  } else if (!p.g) {
    p.vy = Math.min(PHYS.maxFall, p.vy + PHYS.gravity * p.gravMul * DT);
  }
  p.x += p.vx * DT;
  p.y += p.vy * DT;

  // ステージ
  const half = STAGE.w / 2;
  const edge = half + p.bw / 4;
  if (!p.g && p.vy >= 0 && prevY <= STAGE.top + 1 && p.y >= STAGE.top && Math.abs(p.x) <= edge) {
    p.y = STAGE.top;
    p.vy = 0;
    p.g = true;
    p.airJump = false; // 着地で回復
    p.airSp = false;
  } else if (p.g && Math.abs(p.x) > edge) {
    p.g = false;
  }
  // ステージの側面(壁)
  if (!p.g && p.y > STAGE.top + 24 && p.y < STAGE.top + STAGE.wall + p.bh && Math.abs(p.x) < half + p.bw / 2) {
    p.x = p.x < 0 ? -half - p.bw / 2 : half + p.bw / 2;
    p.vx = 0;
  }

  if (!stunned) tryGrab(p, occ); // 崖つかまり

  // 技の当たり判定・弾
  if (p.atk) {
    p.atk.mv.act(p, p.atk.t, makeFx(p, env));
    const a = p.atk;
    if (a && a.t >= (a.end || a.mv.total)) p.atk = null;
  }

  // 画面外に出たら撃墜
  if (Math.abs(p.x) > BLAST.x || p.y > BLAST.bottom || p.y < BLAST.top) p.ko = true;
}

// ---------- 部屋 ----------
const rooms = new Map();

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcast(r, obj) {
  const s = JSON.stringify(obj);
  for (const p of r.players.values()) {
    if (p.ws && p.ws.readyState === 1) p.ws.send(s);
  }
}

function rosterMsg(r) {
  return {
    t: 'roster',
    phase: r.phase,
    p: [...r.players.values()].map((p) => ({ s: p.slot, r: p.active ? 1 : 0, v: p.vote ? 1 : 0 })),
  };
}

function allReady(r) {
  if (r.players.size === 0) return false;
  for (const p of r.players.values()) if (!p.active) return false;
  return true;
}

function startMatch(r) {
  r.phase = 'play';
  r.versus = r.players.size >= 2;
  r.events = [];
  r.projs = [];
  r.tick = 0;
  for (const p of r.players.values()) {
    resetFighter(p);
    spawn(p, false);
  }
  broadcast(r, rosterMsg(r));
}

// 試合終了。winner は勝った人の番号(ひきわけは -1)
function endMatch(r, winner) {
  r.phase = 'result';
  for (const p of r.players.values()) p.vote = false;
  broadcast(r, { t: 'result', w: winner });
  broadcast(r, rosterMsg(r));
}

// 全員が「もういちど」を押したら、同じキャラでもう一度
function checkRematch(r) {
  if (r.phase !== 'result') return;
  const act = [...r.players.values()].filter((p) => p.active);
  if (act.length === 0 || !act.every((p) => p.vote)) return;
  r.versus = act.length >= 2;
  r.events = [];
  r.projs = [];
  r.tick = 0;
  for (const p of act) {
    resetFighter(p);
    spawn(p, false);
    p.inv = 60;
  }
  r.phase = 'play';
  broadcast(r, rosterMsg(r));
}

function artMsg(p) {
  return { t: 'art', s: p.slot, rig: p.rig, w: p.bw, h: p.bh, sp: p.colSp, nm: p.colNm };
}

// 届いた絵のデータを確認して、安全な形にそろえる
function cleanRig(r) {
  if (!r || typeof r !== 'object') return null;
  const w = Math.round(+r.w);
  const h = Math.round(+r.h);
  if (!(w >= 4 && w <= 256 && h >= 4 && h <= 256)) return null;
  const okImg = (v) => typeof v === 'string' && v.startsWith('data:image/png;base64,') && v.length <= 200000;
  if (!okImg(r.body)) return null;
  if (!Array.isArray(r.parts) || r.parts.length > 8) return null;
  const num = (v, max) => Math.max(0, Math.min(max, +v || 0));
  const parts = [];
  for (const p of r.parts) {
    if (!p || (p.k !== 'h' && p.k !== 'f') || !okImg(p.img)) return null;
    parts.push({
      k: p.k,
      i: Math.max(0, Math.min(7, Math.floor(+p.i) || 0)),
      img: p.img,
      x: num(p.x, 256), y: num(p.y, 256), w: num(p.w, 256), h: num(p.h, 256),
      px: num(p.px, 256), py: num(p.py, 256),
      a: Math.floor(num(p.a, 65536)),
      d0: Math.max(-7, Math.min(7, +p.d0 || 0)),
    });
  }
  const hb = Array.isArray(r.hb) && r.hb.length === 4 ? r.hb.map((v) => num(v, 256)) : [0, 0, w, h];
  const rig = { w, h, body: r.body, hb, parts };
  if (JSON.stringify(rig).length > 500000) return null;
  return rig;
}

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/r/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/healthz', (req, res) => res.send('ok'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 600 * 1024 });

function clampInt(v, max) {
  return Math.max(0, Math.min(max, Math.floor(+v) || 0));
}

wss.on('connection', (ws) => {
  let room = null;
  let player = null;

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }

    if (m.t === 'join' && !room) {
      const id = String(m.room || '').toLowerCase();
      if (!/^[a-z0-9]{3,12}$/.test(id)) return ws.close();

      let r = rooms.get(id);
      if (!r) {
        r = { id, players: new Map(), tick: 0, phase: 'draw', versus: false, events: [], projs: [] };
        rooms.set(id, r);
      }
      let slot = -1;
      for (let s = 0; s < MAX_PLAYERS; s++) {
        if (!r.players.has(s)) { slot = s; break; }
      }
      if (slot < 0) {
        send(ws, { t: 'full' });
        return ws.close();
      }
      room = r;
      player = makePlayer(slot);
      player.ws = ws;
      r.players.set(slot, player);

      send(ws, { t: 'welcome', you: slot, room: id, stage: STAGE, phase: r.phase });
      for (const q of r.players.values()) {
        if (q.active && q.rig) send(ws, artMsg(q));
      }
      broadcast(r, rosterMsg(r));

    } else if (!player) {
      return;

    } else if (m.t === 'input') {
      player.input = { l: m.l ? 1 : 0, r: m.r ? 1 : 0, j: m.j ? 1 : 0, a: m.a ? 1 : 0, b: m.b ? 1 : 0 };

    } else if (m.t === 'art') {
      // 描いた絵を受け取る
      const rig = cleanRig(m.rig);
      if (!rig) return;
      if (room.phase !== 'draw' && player.active) return;

      player.rig = rig;
      player.bw = rig.w * SCALE;
      player.bh = rig.h * SCALE;
      player.hb = rig.hb.map((v) => v * SCALE);
      player.limbs = rig.parts.map((p) => ({ k: p.k, a: p.a }));
      player.area = clampInt(m.area, 65536);
      player.colors = Array.isArray(m.c) && m.c.length === 5 ? m.c.map((v) => clampInt(v, 65536)) : [0, 0, 0, 0, 0];
      applyBody(player);
      resetFighter(player);
      player.active = true;
      spawn(player, false);

      broadcast(room, artMsg(player));
      if (room.phase === 'draw' && room.players.size === MAX_PLAYERS && allReady(room)) {
        startMatch(room);
      } else {
        broadcast(room, rosterMsg(room));
      }

    } else if (m.t === 'redraw') {
      // 試合が始まる前なら、描き直せる
      if (room.phase === 'draw' && player.active) {
        player.active = false;
        player.rig = null;
        broadcast(room, rosterMsg(room));
      }

    } else if (m.t === 'start') {
      // 全員かけたら「はじめる」で試合開始
      if (room.phase === 'draw' && allReady(room)) startMatch(room);

    } else if (m.t === 'rematch') {
      // 試合のあと「もういちど」
      if (room.phase === 'result' && player.active) {
        player.vote = true;
        checkRematch(room);
        if (room.phase === 'result') broadcast(room, rosterMsg(room));
      }
    }
  });

  ws.on('close', () => {
    if (room && player) {
      room.players.delete(player.slot);
      if (room.players.size === 0) {
        rooms.delete(room.id);
      } else {
        checkRematch(room);
        broadcast(room, rosterMsg(room));
      }
    }
  });
});

// 接続が切れないように、定期的に声をかける
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.readyState === 1) ws.ping();
  }
}, 25000);

// ---------- メインループ ----------
setInterval(() => {
  for (const r of rooms.values()) {
    if (r.phase !== 'play') continue;
    r.tick++;

    const present = [...r.players.values()].filter((p) => p.active);
    if (present.length >= 2) r.versus = true;

    // 復活
    for (const p of present) {
      if (p.life === 1 && --p.respT <= 0) respawn(p);
    }

    // 戦っている人を動かす
    const alive = present.filter((p) => p.life === 0);
    const occ = {}; // 崖ごとに、つかまっている人
    for (const p of alive) if (p.hang) occ[p.hang] = p.slot;
    const env = { others: alive, events: r.events, projs: r.projs };
    for (const p of alive) step(p, occ, env);
    stepProjectiles(r, alive);
    for (const p of alive) if (p.ko) koPlayer(r, p, r.events);

    // 勝敗(対戦のとき、残機が残っている人が1人以下になったら終わり)
    let ended = false;
    if (r.versus) {
      const holders = present.filter((p) => p.stocks > 0);
      if (holders.length <= 1) {
        endMatch(r, holders.length ? holders[0].slot : -1);
        ended = true;
      }
    }

    if (r.tick % SEND_EVERY === 0 || ended) {
      const msg = {
        t: 'state',
        p: present.map((p) => ({
          s: p.slot,
          x: +p.x.toFixed(1),
          y: +p.y.toFixed(1),
          f: p.f,
          g: p.g ? 1 : 0,
          h: p.hang ? 1 : 0,
          vx: Math.round(p.vx),
          vy: Math.round(p.vy),
          d: p.dmg,
          st: p.stocks,
          l: p.life,
          iv: p.inv > 0 ? 1 : 0,
          hs: p.stun > 0 ? 1 : 0,
          at: p.atk ? animOf(p.atk).at : 0,
          tt: p.atk ? animOf(p.atk).tt : 0,
          ms: p.atk ? animOf(p.atk).ms : '',
          ch: p.atk && p.atk.mv.chargeT && p.atk.t <= p.atk.mv.chargeT ? Math.round((100 * p.atk.t) / p.atk.mv.chargeT) : 0,
          fx: p.fxAcc,
        })),
        pj: r.projs.map((b) => [Math.round(b.x), Math.round(b.y), Math.round(b.r), b.col, Math.round(b.vx), Math.round(b.vy)]),
      };
      for (const p of present) p.fxAcc = [];
      if (r.events.length) {
        msg.ev = r.events;
        r.events = [];
      }
      broadcast(r, msg);
    }
  }
}, 1000 / TICK);

server.listen(PORT, () => console.log('listening on ' + PORT));
