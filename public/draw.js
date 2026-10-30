// お絵描き画面(試合の前にキャラを描く)
(() => {
  const SIZE = 256; // キャンバスの大きさ(ピクセル)
  const PALETTE = [
    { name: '赤', css: '#e5322d', rgb: [229, 50, 45] },
    { name: '青', css: '#2563e8', rgb: [37, 99, 232] },
    { name: '黄', css: '#f5c518', rgb: [245, 197, 24] },
    { name: '白', css: '#ffffff', rgb: [255, 255, 255] },
    { name: '黒', css: '#151515', rgb: [21, 21, 21] },
  ];
  const SIZES = [6, 14, 28];
  const SLOT_COLORS = ['#e5322d', '#2563e8', '#f5c518', '#ffffff'];

  let handlers = {};
  let colorIdx = 0;
  let tool = 'pen'; // pen | eraser | fill
  let sizeIdx = 1;
  const undoStack = [];

  // ---------- 見た目 ----------
  const style = document.createElement('style');
  style.textContent = `
#dp { position: fixed; inset: 0; z-index: 100; background: #cfe3f2; display: flex; flex-direction: column; gap: 8px;
  padding: calc(10px + env(safe-area-inset-top, 0px)) calc(10px + env(safe-area-inset-right, 0px)) calc(10px + env(safe-area-inset-bottom, 0px)) calc(10px + env(safe-area-inset-left, 0px)); }
#dp[hidden] { display: none; }
.dp-top { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dp-title { font-weight: 700; font-size: 20px; }
#dp-roster { display: flex; gap: 6px; flex-wrap: wrap; flex: 1; }
.dp-chip { display: flex; align-items: center; gap: 5px; background: #fff; border: 3px solid #151515; border-radius: 10px; padding: 3px 8px; font-size: 13px; font-weight: 700; }
.dp-chip i { width: 14px; height: 14px; border-radius: 50%; border: 2px solid #151515; }
.dp-chip.ok { background: #d8f5d0; }
.dp-main { flex: 1; min-height: 0; display: flex; gap: 10px; }
.dp-stage { flex: 1; min-width: 0; min-height: 0; display: flex; align-items: center; justify-content: center; }
#dp-cv { border: 3px solid #151515; border-radius: 8px; touch-action: none; background-color: #c9ced3;
  background-image: linear-gradient(45deg, #b4bac0 25%, transparent 25%, transparent 75%, #b4bac0 75%), linear-gradient(45deg, #b4bac0 25%, transparent 25%, transparent 75%, #b4bac0 75%);
  background-size: 28px 28px; background-position: 0 0, 14px 14px; }
.dp-tools { width: 214px; display: flex; flex-direction: column; gap: 10px; overflow-y: auto; padding: 2px 4px 6px 2px; }
.dp-row { display: flex; gap: 8px; flex-wrap: wrap; }
.dp-color { width: 44px; height: 44px; border-radius: 50%; border: 3px solid #151515; padding: 0; cursor: pointer; }
.dp-color.sel { outline: 4px solid #151515; outline-offset: 2px; }
.dp-tools .btn { padding: 8px 10px; }
.dp-tools .btn.sel { background: #f5c518; }
.dp-s { width: 52px; height: 44px; display: flex; align-items: center; justify-content: center; }
.dp-s i { display: block; background: #151515; border-radius: 50%; }
.dp-submit { font-size: 20px; background: #7bdc6a; padding: 12px; margin-top: auto; }
#dp-wait { flex: 1; min-height: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; text-align: center; }
#dp-prev { max-width: 70%; max-height: 38vh; min-width: 60px; min-height: 60px; object-fit: contain; border: 3px solid #151515; border-radius: 8px; background-color: #c9ced3; image-rendering: auto; }
#dp-hint { font-size: 16px; font-weight: 700; max-width: 90%; }
.dp-btns { display: flex; gap: 12px; flex-wrap: wrap; justify-content: center; }
.btn:disabled { opacity: .4; cursor: default; }
#dp-msg { position: absolute; left: 50%; bottom: 24px; transform: translateX(-50%); background: #151515; color: #fff; border-radius: 10px; padding: 8px 14px; font-size: 14px; opacity: 0; transition: opacity .2s; pointer-events: none; }
#dp-msg.show { opacity: 1; }
@media (orientation: portrait) {
  .dp-main { flex-direction: column; }
  .dp-tools { width: auto; flex-direction: row; flex-wrap: wrap; overflow-y: auto; max-height: 38%; align-content: flex-start; }
  .dp-submit { margin-top: 0; }
}
`;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = 'dp';
  root.hidden = true;
  root.innerHTML = `
<div class="dp-top">
  <div class="dp-title">キャラをかこう</div>
  <div id="dp-roster"></div>
  <button class="btn" data-a="invite">招待リンクをコピー</button>
</div>
<div class="dp-main" id="dp-draw">
  <div class="dp-stage" id="dp-stage"><canvas id="dp-cv" width="${SIZE}" height="${SIZE}"></canvas></div>
  <div class="dp-tools">
    <div class="dp-row">${PALETTE.map((c, i) => `<button class="dp-color" data-c="${i}" style="background:${c.css}" aria-label="${c.name}"></button>`).join('')}</div>
    <div class="dp-row">
      <button class="btn" data-t="pen">ペン</button>
      <button class="btn" data-t="eraser">けしごむ</button>
      <button class="btn" data-t="fill">ぬりつぶし</button>
    </div>
    <div class="dp-row">${SIZES.map((s, i) => `<button class="btn dp-s" data-s="${i}" aria-label="太さ${i + 1}"><i style="width:${6 + i * 8}px;height:${6 + i * 8}px"></i></button>`).join('')}</div>
    <div class="dp-row">
      <button class="btn" data-a="undo">もどす</button>
      <button class="btn" data-a="clear">ぜんぶけす</button>
    </div>
    <button class="btn dp-submit" data-a="submit">かけた！</button>
  </div>
</div>
<div id="dp-wait" hidden>
  <img id="dp-prev" alt="かいたキャラ">
  <div id="dp-hint"></div>
  <div class="dp-btns">
    <button class="btn" data-a="redraw">かきなおす</button>
    <button class="btn dp-submit" data-a="start" id="dp-start">はじめる</button>
  </div>
</div>
<div id="dp-msg"></div>
`;
  document.body.appendChild(root);

  const $ = (id) => document.getElementById(id);
  const cv = $('dp-cv');
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const stageEl = $('dp-stage');

  // ---------- 画面の大きさに合わせる ----------
  function fit() {
    const r = stageEl.getBoundingClientRect();
    const s = Math.max(120, Math.floor(Math.min(r.width, r.height)) - 4);
    cv.style.width = s + 'px';
    cv.style.height = s + 'px';
  }
  window.addEventListener('resize', fit);

  let msgTimer = 0;
  function msg(text) {
    const m = $('dp-msg');
    m.textContent = text;
    m.classList.add('show');
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => m.classList.remove('show'), 2000);
  }

  function refreshSel() {
    root.querySelectorAll('[data-c]').forEach((b) => b.classList.toggle('sel', +b.dataset.c === colorIdx));
    root.querySelectorAll('[data-t]').forEach((b) => b.classList.toggle('sel', b.dataset.t === tool));
    root.querySelectorAll('[data-s]').forEach((b) => b.classList.toggle('sel', +b.dataset.s === sizeIdx));
  }

  // ---------- ピクセル処理 ----------
  function nearest(r, g, b) {
    let best = 0, bd = Infinity;
    for (let i = 0; i < PALETTE.length; i++) {
      const c = PALETTE[i].rgb;
      const d = (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  // 線のふちのぼかしをなくして、すべて「5色のどれか」か「透明」にそろえる
  function harden() {
    const id = ctx.getImageData(0, 0, SIZE, SIZE);
    const d = id.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 128) {
        d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0;
      } else {
        const c = PALETTE[nearest(d[i], d[i + 1], d[i + 2])].rgb;
        d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255;
      }
    }
    ctx.putImageData(id, 0, 0);
  }

  function pushUndo() {
    if (undoStack.length >= 30) undoStack.shift();
    undoStack.push(ctx.getImageData(0, 0, SIZE, SIZE));
  }

  function floodFill(sx, sy, colorI) {
    if (sx < 0 || sy < 0 || sx >= SIZE || sy >= SIZE) return;
    const id = ctx.getImageData(0, 0, SIZE, SIZE);
    const u32 = new Uint32Array(id.data.buffer);
    const c = PALETTE[colorI].rgb;
    const tmp = new Uint8ClampedArray([c[0], c[1], c[2], 255]);
    const fill = new Uint32Array(tmp.buffer)[0];
    const target = u32[sy * SIZE + sx];
    if (target === fill) return;
    const stack = [sy * SIZE + sx];
    while (stack.length) {
      const i = stack.pop();
      if (u32[i] !== target) continue;
      u32[i] = fill;
      const cx = i % SIZE;
      if (cx > 0) stack.push(i - 1);
      if (cx < SIZE - 1) stack.push(i + 1);
      if (i >= SIZE) stack.push(i - SIZE);
      if (i < SIZE * (SIZE - 1)) stack.push(i + SIZE);
    }
    ctx.putImageData(id, 0, 0);
  }

  // かいた絵を調べる(大きさ・面積・色ごとのピクセル数)して、まわりの透明部分を切り取る
  function analyze() {
    const d = ctx.getImageData(0, 0, SIZE, SIZE).data;
    let minX = SIZE, minY = SIZE, maxX = -1, maxY = -1, area = 0;
    const counts = [0, 0, 0, 0, 0];
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const i = (y * SIZE + x) * 4;
        if (d[i + 3] < 128) continue;
        area++;
        counts[nearest(d[i], d[i + 1], d[i + 2])]++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (area === 0) return null;
    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d').drawImage(cv, minX, minY, w, h, 0, 0, w, h);
    return { img: c.toDataURL('image/png'), w, h, area, c: counts };
  }

  // ---------- 描く ----------
  let drawing = false;
  let pid = null;
  let last = null;

  function pos(e) {
    const r = cv.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * SIZE) / r.width, y: ((e.clientY - r.top) * SIZE) / r.height };
  }

  function setBrush() {
    ctx.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = ctx.fillStyle = PALETTE[colorIdx].css;
    ctx.lineWidth = SIZES[sizeIdx];
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }

  function dot(p) {
    setBrush();
    ctx.beginPath();
    ctx.arc(p.x, p.y, SIZES[sizeIdx] / 2, 0, Math.PI * 2);
    ctx.fill();
  }

  function line(a, b) {
    setBrush();
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  cv.addEventListener('pointerdown', (e) => {
    if (drawing) return;
    e.preventDefault();
    const p = pos(e);
    if (tool === 'fill') {
      pushUndo();
      floodFill(Math.floor(p.x), Math.floor(p.y), colorIdx);
      return;
    }
    cv.setPointerCapture(e.pointerId);
    pid = e.pointerId;
    drawing = true;
    pushUndo();
    last = p;
    dot(p);
  });
  cv.addEventListener('pointermove', (e) => {
    if (!drawing || e.pointerId !== pid) return;
    e.preventDefault();
    const p = pos(e);
    line(last, p);
    last = p;
  });
  const endStroke = (e) => {
    if (!drawing || e.pointerId !== pid) return;
    drawing = false;
    pid = null;
    harden();
  };
  cv.addEventListener('pointerup', endStroke);
  cv.addEventListener('pointercancel', endStroke);

  // ---------- ボタン ----------
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-c],[data-t],[data-s],[data-a]');
    if (!b) return;
    if (b.dataset.c !== undefined) { colorIdx = +b.dataset.c; if (tool === 'eraser') tool = 'pen'; refreshSel(); return; }
    if (b.dataset.t !== undefined) { tool = b.dataset.t; refreshSel(); return; }
    if (b.dataset.s !== undefined) { sizeIdx = +b.dataset.s; refreshSel(); return; }

    const a = b.dataset.a;
    if (a === 'undo') {
      const prev = undoStack.pop();
      if (prev) ctx.putImageData(prev, 0, 0);
    } else if (a === 'clear') {
      pushUndo();
      ctx.clearRect(0, 0, SIZE, SIZE);
    } else if (a === 'submit') {
      const r = analyze();
      if (!r) return msg('なにか描いてね');
      if (r.w < 16 || r.h < 16) return msg('もう少し大きく描いてね');
      $('dp-prev').src = r.img;
      if (handlers.onSubmit) handlers.onSubmit(r);
    } else if (a === 'redraw') {
      if (handlers.onRedraw) handlers.onRedraw();
    } else if (a === 'start') {
      if (handlers.onStart) handlers.onStart();
    } else if (a === 'invite') {
      if (handlers.onInvite) handlers.onInvite();
    }
  });

  refreshSel();

  // ---------- 外から使う入り口 ----------
  function setMode(mode) {
    $('dp-draw').hidden = mode !== 'draw';
    $('dp-wait').hidden = mode !== 'wait';
    $('dp-roster').parentElement.querySelector('.dp-title').textContent = mode === 'draw' ? 'キャラをかこう' : 'みんなを待っています';
    if (mode === 'draw') requestAnimationFrame(fit);
  }

  window.DrawPad = {
    init(h) { handlers = h || {}; },
    open(mode) { root.hidden = false; setMode(mode || 'draw'); },
    close() { root.hidden = true; },
    isOpen() { return !root.hidden; },
    setPreview(url) { $('dp-prev').src = url; },
    toast(text) { msg(text); },
    setRoster(list, me, canStart) {
      $('dp-roster').innerHTML = list.map((p) =>
        `<span class="dp-chip ${p.r ? 'ok' : ''}"><i style="background:${SLOT_COLORS[p.s % 4]}"></i>P${p.s + 1}${p.s === me ? '(あなた)' : ''} ${p.r ? 'OK' : 'かいてる'}</span>`
      ).join('');
      $('dp-start').disabled = !canStart;
      $('dp-hint').textContent = canStart
        ? 'みんなできたよ！「はじめる」を押そう。'
        : '友達に招待リンクを送って、みんながかけるまで待とう。';
    },
  };
})();
