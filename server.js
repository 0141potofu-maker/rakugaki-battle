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

const STAGE = { w: 1800, top: 0, depth: 300 }; // 終点風。上面が y=0
const BODY = { w: 56, h: 84 }; // ステップ1は四角い仮キャラ
const BLAST = { x: 1500, top: -1200, bottom: 900 }; // これを超えたら撃墜
const PHYS = {
  run: 430,
  groundAcc: 3200,
  airAcc: 1800,
  groundFric: 3600,
  airFric: 500,
  gravity: 2600,
  maxFall: 1200,
  jump: 930,
  airJump: 820,
};

// ---------- プレイヤー ----------
function makePlayer(slot) {
  const p = {
    slot,
    ws: null,
    x: 0, y: 0, vx: 0, vy: 0,
    f: 1,          // 向き 1=右 -1=左
    g: true,       // 接地
    airJump: false, // 空中ジャンプ使用済み
    prevJ: false,
    input: { l: 0, r: 0, j: 0 },
  };
  spawn(p, false);
  return p;
}

function spawn(p, fromAir) {
  p.x = -300 + p.slot * 200;
  p.y = fromAir ? -450 : STAGE.top;
  p.vx = 0;
  p.vy = 0;
  p.g = !fromAir;
  p.airJump = false;
}

function step(p) {
  const i = p.input;
  const dir = (i.r ? 1 : 0) - (i.l ? 1 : 0);

  // 左右移動
  if (dir) {
    p.f = dir;
    const acc = p.g ? PHYS.groundAcc : PHYS.airAcc;
    const target = dir * PHYS.run;
    if (p.vx < target) p.vx = Math.min(target, p.vx + acc * DT);
    else p.vx = Math.max(target, p.vx - acc * DT);
  } else {
    const fr = p.g ? PHYS.groundFric : PHYS.airFric;
    if (p.vx > 0) p.vx = Math.max(0, p.vx - fr * DT);
    else p.vx = Math.min(0, p.vx + fr * DT);
  }

  // ジャンプ(押した瞬間だけ)
  if (i.j && !p.prevJ) {
    if (p.g) {
      p.vy = -PHYS.jump;
      p.g = false;
    } else if (!p.airJump) {
      p.vy = -PHYS.airJump;
      p.airJump = true;
    }
  }
  p.prevJ = !!i.j;

  // 移動
  const prevY = p.y;
  if (!p.g) p.vy = Math.min(PHYS.maxFall, p.vy + PHYS.gravity * DT);
  p.x += p.vx * DT;
  p.y += p.vy * DT;

  // ステージ
  const half = STAGE.w / 2;
  const edge = half + BODY.w / 4;
  if (!p.g && p.vy >= 0 && prevY <= STAGE.top + 1 && p.y >= STAGE.top && Math.abs(p.x) <= edge) {
    p.y = STAGE.top;
    p.vy = 0;
    p.g = true;
    p.airJump = false; // 着地で回復
  } else if (p.g && Math.abs(p.x) > edge) {
    p.g = false;
  }
  // ステージの側面(壁)
  if (!p.g && p.y > STAGE.top + 24 && p.y < STAGE.top + STAGE.depth + BODY.h && Math.abs(p.x) < half + BODY.w / 2) {
    p.x = p.x < 0 ? -half - BODY.w / 2 : half + BODY.w / 2;
    p.vx = 0;
  }

  // 撃墜(今は即復活。ダメージ・ストックは後のステップで)
  if (Math.abs(p.x) > BLAST.x || p.y > BLAST.bottom || p.y < BLAST.top) {
    spawn(p, true);
  }
}

// ---------- 部屋 ----------
const rooms = new Map();

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/r/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/healthz', (req, res) => res.send('ok'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 });

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
        r = { id, players: new Map(), tick: 0 };
        rooms.set(id, r);
      }
      let slot = -1;
      for (let s = 0; s < MAX_PLAYERS; s++) {
        if (!r.players.has(s)) { slot = s; break; }
      }
      if (slot < 0) {
        ws.send(JSON.stringify({ t: 'full' }));
        return ws.close();
      }
      room = r;
      player = makePlayer(slot);
      player.ws = ws;
      r.players.set(slot, player);
      ws.send(JSON.stringify({ t: 'welcome', you: slot, room: id, stage: STAGE, body: BODY }));
    } else if (m.t === 'input' && player) {
      player.input = { l: m.l ? 1 : 0, r: m.r ? 1 : 0, j: m.j ? 1 : 0 };
    }
  });

  ws.on('close', () => {
    if (room && player) {
      room.players.delete(player.slot);
      if (room.players.size === 0) rooms.delete(room.id);
    }
  });
});

// ---------- メインループ ----------
setInterval(() => {
  for (const r of rooms.values()) {
    r.tick++;
    for (const p of r.players.values()) step(p);

    if (r.tick % SEND_EVERY === 0) {
      const msg = JSON.stringify({
        t: 'state',
        p: [...r.players.values()].map((p) => ({
          s: p.slot,
          x: +p.x.toFixed(1),
          y: +p.y.toFixed(1),
          f: p.f,
          g: p.g ? 1 : 0,
        })),
      });
      for (const p of r.players.values()) {
        if (p.ws && p.ws.readyState === 1) p.ws.send(msg);
      }
    }
  }
}, 1000 / TICK);

server.listen(PORT, () => console.log('listening on ' + PORT));
