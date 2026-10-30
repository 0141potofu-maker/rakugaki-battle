(() => {
  const $ = (id) => document.getElementById(id);

  // ---------- ホーム画面 ----------
  const match = location.pathname.match(/^\/r\/([a-z0-9]{3,12})$/i);
  if (!match) {
    $('home').hidden = false;
    $('makeRoom').onclick = () => {
      const id = Math.random().toString(36).slice(2, 7);
      location.href = '/r/' + id;
    };
    return;
  }
  $('game').hidden = false;

  // ---------- 状態 ----------
  const room = match[1].toLowerCase();
  const COLORS = ['#e5322d', '#2563e8', '#f5c518', '#ffffff']; // P1〜P4
  const INK = '#151515';

  let ws = null;
  let me = -1;
  let stage = { w: 1800, top: 0, depth: 300 };
  let body = { w: 56, h: 84 };
  const players = new Map(); // slot -> {x,y,tx,ty,f,g}

  function setStatus(text) { $('status').textContent = text || ''; }
  function updateCount() { $('count').textContent = players.size + ' / 4人'; }

  let toastTimer = 0;
  function toast(text) {
    const t = $('toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
  }

  // ---------- 通信 ----------
  let sentInput = '';
  function connect() {
    setStatus('つないでいます…');
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');

    ws.onopen = () => {
      sentInput = '';
      ws.send(JSON.stringify({ t: 'join', room }));
    };

    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.t === 'welcome') {
        me = m.you;
        stage = m.stage;
        body = m.body;
        setStatus('');
      } else if (m.t === 'full') {
        setStatus('この部屋は満員です(最大4人)。');
      } else if (m.t === 'state') {
        const alive = new Set();
        for (const p of m.p) {
          alive.add(p.s);
          let o = players.get(p.s);
          if (!o) {
            o = { x: p.x, y: p.y, tx: p.x, ty: p.y, f: p.f, g: p.g };
            players.set(p.s, o);
          }
          o.tx = p.x; o.ty = p.y; o.f = p.f; o.g = p.g;
        }
        for (const s of [...players.keys()]) if (!alive.has(s)) players.delete(s);
        updateCount();
      }
    };

    ws.onclose = () => {
      if ($('status').textContent !== 'この部屋は満員です(最大4人)。') {
        setStatus('切断されました。ページを開き直してください。');
      }
    };
  }

  // ---------- 入力 ----------
  const input = { l: 0, r: 0, j: 0 };
  function sendInput() {
    const s = JSON.stringify({ t: 'input', l: input.l, r: input.r, j: input.j });
    if (s !== sentInput && ws && ws.readyState === 1) {
      ws.send(s);
      sentInput = s;
    }
  }

  const KEYMAP = {
    ArrowLeft: 'l', KeyA: 'l',
    ArrowRight: 'r', KeyD: 'r',
    ArrowUp: 'j', KeyW: 'j', Space: 'j',
  };
  window.addEventListener('keydown', (e) => {
    const k = KEYMAP[e.code];
    if (!k) return;
    e.preventDefault();
    input[k] = 1;
    sendInput();
  });
  window.addEventListener('keyup', (e) => {
    const k = KEYMAP[e.code];
    if (!k) return;
    e.preventDefault();
    input[k] = 0;
    sendInput();
  });
  window.addEventListener('blur', () => {
    input.l = input.r = input.j = 0;
    sendInput();
  });

  document.querySelectorAll('[data-k]').forEach((b) => {
    const k = b.dataset.k;
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      b.setPointerCapture(e.pointerId);
      b.classList.add('on');
      input[k] = 1;
      sendInput();
    });
    const up = () => {
      b.classList.remove('on');
      input[k] = 0;
      sendInput();
    };
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((n) => b.addEventListener(n, up));
  });
  document.addEventListener('contextmenu', (e) => e.preventDefault());

  // ---------- 招待リンク ----------
  $('invite').onclick = async () => {
    const url = location.href;
    try {
      if (navigator.share && /Mobi|Android|iPad/i.test(navigator.userAgent)) {
        await navigator.share({ title: 'ラクガキバトル', url });
      } else {
        await navigator.clipboard.writeText(url);
        toast('リンクをコピーしました');
      }
    } catch (err) {
      // 共有をキャンセルした場合など
    }
  };

  // ---------- 描画 ----------
  const cv = $('cv');
  const ctx = cv.getContext('2d');
  let W = 0, H = 0, dpr = 1;
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
  }
  window.addEventListener('resize', resize);
  resize();

  const cam = { x: 0, y: -80, s: 0.5, ready: false };

  function updateCamera(dt) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const o of players.values()) {
      minX = Math.min(minX, o.x - body.w / 2);
      maxX = Math.max(maxX, o.x + body.w / 2);
      minY = Math.min(minY, o.y - body.h);
      maxY = Math.max(maxY, o.y);
    }
    if (minX === Infinity) { minX = maxX = 0; minY = -body.h; maxY = 0; }

    const spanX = Math.max(maxX - minX + 700, 1000);
    const spanY = Math.max(maxY - minY + 500, 600);
    const ts = Math.min(W / spanX, H / spanY);
    const tx = (minX + maxX) / 2;
    const ty = (minY + maxY) / 2 - 40;

    if (!cam.ready) {
      cam.x = tx; cam.y = ty; cam.s = ts; cam.ready = true;
    } else {
      const k = 1 - Math.exp(-dt * 4);
      cam.x += (tx - cam.x) * k;
      cam.y += (ty - cam.y) * k;
      cam.s += (ts - cam.s) * k;
    }
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawStage() {
    const half = stage.w / 2;
    const top = stage.top;
    const bottom = top + stage.depth;
    ctx.lineJoin = 'round';
    ctx.lineWidth = 5;
    ctx.strokeStyle = INK;

    ctx.fillStyle = '#2a2a33';
    ctx.beginPath();
    ctx.moveTo(-half, top);
    ctx.lineTo(half, top);
    ctx.lineTo(half - 140, bottom);
    ctx.lineTo(-half + 140, bottom);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#5a5a6a';
    ctx.fillRect(-half + 3, top + 2, stage.w - 6, 14);
  }

  function drawPlayer(slot, o) {
    const x = o.x;
    const y = o.y;
    const w = body.w;
    const h = body.h;

    ctx.fillStyle = COLORS[slot % COLORS.length];
    ctx.strokeStyle = INK;
    ctx.lineWidth = 5;
    roundRect(x - w / 2, y - h, w, h, 14);
    ctx.fill();
    ctx.stroke();

    // 目(向いている方向に寄せる)
    ctx.fillStyle = INK;
    const ex = x + o.f * 9;
    ctx.beginPath();
    ctx.arc(ex - 8, y - h + 28, 4.5, 0, Math.PI * 2);
    ctx.arc(ex + 8, y - h + 28, 4.5, 0, Math.PI * 2);
    ctx.fill();

    // 名前
    ctx.font = '700 22px sans-serif';
    ctx.textAlign = 'center';
    ctx.lineWidth = 5;
    ctx.strokeStyle = '#fff';
    const label = 'P' + (slot + 1);
    ctx.strokeText(label, x, y - h - 12);
    ctx.fillStyle = INK;
    ctx.fillText(label, x, y - h - 12);

    // 自分の目印
    if (slot === me) {
      ctx.fillStyle = INK;
      ctx.beginPath();
      ctx.moveTo(x, y - h - 52);
      ctx.lineTo(x - 11, y - h - 70);
      ctx.lineTo(x + 11, y - h - 70);
      ctx.closePath();
      ctx.fill();
    }
  }

  function draw() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    const g = ctx.createLinearGradient(0, 0, 0, cv.height);
    g.addColorStop(0, '#b6d5ee');
    g.addColorStop(1, '#eef5fb');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, cv.width, cv.height);

    const s = cam.s;
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * (W / 2 - cam.x * s), dpr * (H / 2 - cam.y * s));

    drawStage();
    const slots = [...players.keys()].sort((a, b) => a - b);
    for (const slot of slots) drawPlayer(slot, players.get(slot));
  }

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    const k = 1 - Math.exp(-dt * 25);
    for (const o of players.values()) {
      if (Math.abs(o.tx - o.x) > 300 || Math.abs(o.ty - o.y) > 300) { o.x = o.tx; o.y = o.ty; }
      o.x += (o.tx - o.x) * k;
      o.y += (o.ty - o.y) * k;
    }

    updateCamera(dt);
    draw();
    requestAnimationFrame(frame);
  }

  connect();
  requestAnimationFrame(frame);
})();
