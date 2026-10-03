const $ = id => document.getElementById(id);
const canvas = $('board');
const ctx = canvas.getContext('2d');
const titleEl = $('title');
const statusEl = $('status');
const extraEl = $('extra');
const actionBtn = $('action');
const shareBtn = $('share');
const muteBtn = $('mute');
const modeBtns = document.querySelectorAll('[data-mode]');

// 邏輯座標，實際像素依 devicePixelRatio 放大
const W = 640, H = 440;
const GROUND = 410;  // 右桶底部
const STAND = 250;   // 左桶底部（放在高台上）
const PIPE_Y = STAND - 9;
const MAX_LIVES = 3;
const FLOW_SPEED = 60; // 放水時左桶水位每秒下降的 px
const DAILY_ROUNDS = 10;
const GRAVITY = 700;

const dpr = window.devicePixelRatio || 1;
canvas.width = W * dpr;
canvas.height = H * dpr;
ctx.scale(dpr, dpr);

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

// ---------- 亂數 ----------
// 每日挑戰用日期當種子，大家拿到同一組題目；特效一律用 Math.random，不影響題目
function mulberry32(seed) {
  return () => {
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function hashStr(s) {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

let rng = Math.random;
const rand = (a, b) => a + rng() * (b - a);
const fx = (a, b) => a + Math.random() * (b - a);

// ---------- 音效（Web Audio 即時合成，不需音檔） ----------
const sound = {
  ac: null,
  muted: store.get('mini-games-muted') === '1',
  pour: null,
  init() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!this.ac && AC) this.ac = new AC();
    if (this.ac && this.ac.state === 'suspended') this.ac.resume();
  },
  get on() { return this.ac && !this.muted; },
  tone(freq, delay, dur, type = 'sine', vol = 0.15) {
    if (!this.on) return;
    const t = this.ac.currentTime + delay;
    const osc = this.ac.createOscillator();
    const g = this.ac.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(g).connect(this.ac.destination);
    osc.start(t);
    osc.stop(t + dur);
  },
  tick() { this.tone(1200, 0, 0.03, 'square', 0.03); },
  valve() { this.tone(160, 0, 0.12, 'triangle', 0.2); },
  success() { [523, 659, 784, 1047].forEach((f, i) => this.tone(f, i * 0.09, 0.25, 'sine', 0.14)); },
  fail() { this.tone(311, 0, 0.2, 'triangle', 0.18); this.tone(208, 0.16, 0.4, 'triangle', 0.18); },
  startPour() {
    if (!this.on || this.pour) return;
    // 帶通濾波的白噪音 = 水聲；濾波頻率隨水位升高，就像裝瓶時音調變高
    const len = this.ac.sampleRate;
    const buf = this.ac.createBuffer(1, len, len);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = this.ac.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const filter = this.ac.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 400;
    filter.Q.value = 6;
    const g = this.ac.createGain();
    g.gain.setValueAtTime(0, this.ac.currentTime);
    g.gain.linearRampToValueAtTime(0.5, this.ac.currentTime + 0.08);
    src.connect(filter).connect(g).connect(this.ac.destination);
    src.start();
    this.pour = { src, filter, g };
  },
  setPour(fill) {
    if (!this.pour) return;
    this.pour.filter.frequency.setTargetAtTime(350 + fill * 1500, this.ac.currentTime, 0.05);
  },
  stopPour() {
    if (!this.pour) return;
    const { src, g } = this.pour;
    g.gain.setTargetAtTime(0, this.ac.currentTime, 0.05);
    src.stop(this.ac.currentTime + 0.3);
    this.pour = null;
  },
};

function vibrate(pattern) {
  try { navigator.vibrate && navigator.vibrate(pattern); } catch {}
}

// ---------- 遊戲狀態 ----------
// 2D 畫面裡用「寬度」代表截面積：體積 = 寬 × 高
let mode = store.get('buckets-mode') === 'daily' ? 'daily' : 'endless';
let level = 1, lives = MAX_LIVES;
let best = Number(store.get('buckets-best')) || 0;
let dailyDate, dailyIdx, dailyResults, dailyPractice;
let phase, round, marker, leftLevel, rightLevel, overflow, outcome, message, pipeWet;

// 特效狀態
let time = 0, waveL = 0.8, waveR = 0.8, shake = 0, splashAcc = 0, lastTick = 0;
const particles = [];

const OUTCOME = {
  hit: { emoji: '🟩', msg: '🎉 完美！剛好落在安全區間' },
  low: { emoji: '🟨', msg: '太少了，水位沒到綠色區間' },
  high: { emoji: '🟥', msg: '太多了，水位超過綠色區間' },
  spill: { emoji: '💦', msg: '💦 溢出來了！' },
};

const dailyKey = () => `buckets-daily-${dailyDate}`;
const savedDaily = () => store.get(dailyKey())?.split(',') ?? null;
const difficulty = () => mode === 'endless' ? level : 1 + dailyIdx * 1.5;

function makeRound(diff) {
  for (;;) {
    const lw = rand(70, 170), lh = rand(140, 200);
    const rw = rand(70, 200), rh = rand(90, 160);
    const w0 = lh * rand(0.65, 0.92);
    // 安全區間半寬，難度越高越窄
    const tol = Math.max(4, rh * (0.09 - diff * 0.006));
    const center = rh * rand(0.3, 0.75);
    const lo = center - tol, hi = center + tol;
    // 換算成左桶需要下降的高度
    const dropLo = lo * rw / lw, dropHi = hi * rw / lw;
    if (dropHi < w0 * 0.95 && dropLo > 8 && dropHi - dropLo >= 3) {
      const rx = W - 60 - rw;
      return { lw, lh, rw, rh, w0, lo, hi, dropLo, dropHi, lx: 70, rx, sx: rx + 22 };
    }
  }
}

function newRound() {
  round = makeRound(difficulty());
  marker = leftLevel = round.w0;
  rightLevel = 0;
  overflow = false;
  pipeWet = false;
  outcome = null;
  particles.length = 0;
  phase = 'ready';
  message = mode === 'daily'
    ? `第 ${dailyIdx + 1} / ${DAILY_ROUNDS} 題：按「開始放水」，覺得夠了就按「停」`
    : '按「開始放水」，紅線會往下掉，覺得夠了就按「停」';
}

function setMode(m) {
  mode = m;
  store.set('buckets-mode', m);
  sound.stopPour();
  if (m === 'endless') {
    rng = Math.random;
    level = 1;
    lives = MAX_LIVES;
    newRound();
  } else {
    startDaily(false);
  }
  updateHud();
}

function startDaily(practice) {
  dailyDate = today();
  rng = mulberry32(hashStr(`buckets-${dailyDate}`));
  dailyIdx = 0;
  dailyResults = [];
  const saved = savedDaily();
  if (saved && !practice) {
    // 今天已經玩過，直接顯示正式成績
    dailyResults = saved;
    dailyPractice = false;
    phase = 'dailyDone';
    particles.length = 0;
    return;
  }
  dailyPractice = !!saved;
  newRound();
}

function markerSpeed() {
  return Math.min(70, 32 + difficulty() * 3);
}

function act() {
  sound.init();
  if (phase === 'ready') {
    phase = 'aiming';
    lastTick = Math.floor(marker / 20);
    message = '紅線以上的水會流到右桶…';
  } else if (phase === 'aiming') {
    phase = 'flowing';
    pipeWet = true;
    message = '放水中…';
    sound.valve();
    sound.startPour();
  } else if (phase === 'result') {
    if (mode === 'daily') {
      if (dailyResults.length >= DAILY_ROUNDS) {
        phase = 'dailyDone';
        particles.length = 0;
        if (!dailyPractice) confetti(W / 2, 140, 80);
      } else {
        dailyIdx++;
        newRound();
      }
    } else {
      newRound();
    }
  } else if (phase === 'over') {
    level = 1;
    lives = MAX_LIVES;
    newRound();
  } else if (phase === 'dailyDone') {
    startDaily(true);
  }
  updateHud();
}

function finish() {
  sound.stopPour();
  outcome = overflow ? 'spill'
    : rightLevel < round.lo ? 'low'
    : rightLevel > round.hi ? 'high'
    : 'hit';
  message = OUTCOME[outcome].msg;
  waveR = 6; // 停水瞬間水面晃一下
  // 出水口殘留的水滴
  for (let i = 0; i < 4; i++) {
    particles.push({ kind: 'drop', x: round.sx + fx(-2, 2), y: PIPE_Y + 14, vx: 0, vy: fx(-20, 60), r: fx(1.5, 2.5), life: 1, floor: GROUND - rightLevel });
  }

  const ok = outcome === 'hit';
  if (ok) {
    sound.success();
    vibrate([30, 40, 30]);
    confetti(round.rx + round.rw / 2, GROUND - round.rh - 10, 50);
  } else {
    sound.fail();
    vibrate(160);
    shake = 0.4;
  }

  if (mode === 'endless') {
    if (ok) {
      level++;
      if (level - 1 > best) {
        best = level - 1;
        store.set('buckets-best', best);
      }
    } else {
      lives--;
    }
    phase = lives > 0 ? 'result' : 'over';
    if (phase === 'over') message = `遊戲結束！你過了 ${level - 1} 關`;
  } else {
    dailyResults.push(outcome);
    phase = 'result';
    if (dailyResults.length === DAILY_ROUNDS && !dailyPractice) {
      store.set(dailyKey(), dailyResults.join(','));
    }
  }
  updateHud();
}

// ---------- 粒子 ----------
function confetti(x, y, n) {
  const colors = [C.zoneLine, C.food, C.water, C.marker, '#f5b83d'];
  for (let i = 0; i < n; i++) {
    particles.push({
      kind: 'confetti', x, y,
      vx: fx(-240, 240), vy: fx(-380, -140),
      w: fx(5, 9), h: fx(3, 5), rot: fx(0, 6), vr: fx(-10, 10),
      color: colors[i % colors.length], life: fx(1.2, 2),
    });
  }
}

function spill() {
  const { rx, rw, rh } = round;
  for (let i = 0; i < 36; i++) {
    const left = i % 2 === 0;
    particles.push({
      kind: 'drop',
      x: left ? rx - 2 : rx + rw + 2, y: GROUND - rh,
      vx: (left ? -1 : 1) * fx(20, 130), vy: fx(-120, 0),
      r: fx(1.5, 3.5), life: 1.5, floor: GROUND,
    });
  }
}

function updateParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;
    p.vy += (p.kind === 'confetti' ? 420 : GRAVITY) * dt;
    if (p.kind === 'confetti') {
      p.vx *= 1 - dt * 1.2;
      p.rot += p.vr * dt;
    }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    // 水滴落回水面（或地面）就消失
    if (p.life <= 0 || (p.kind === 'drop' && p.vy > 0 && p.y > p.floor)) particles.splice(i, 1);
  }
}

// ---------- 更新 ----------
function update(dt) {
  time += dt;
  if (phase === 'aiming') {
    marker -= markerSpeed() * dt;
    const t = Math.floor(marker / 20);
    if (t < lastTick) {
      lastTick = t;
      sound.tick();
    }
    if (marker <= 0) {
      marker = 0;
      act();
    }
  } else if (phase === 'flowing') {
    leftLevel = Math.max(marker, leftLevel - FLOW_SPEED * dt);
    rightLevel = (round.w0 - leftLevel) * round.lw / round.rw;
    sound.setPour(rightLevel / round.rh);
    // 水柱打到水面濺起的水花
    splashAcc += dt * 55;
    const surface = GROUND - Math.min(rightLevel, round.rh);
    while (splashAcc >= 1) {
      splashAcc--;
      particles.push({ kind: 'drop', x: round.sx + fx(-3, 3), y: surface, vx: fx(-90, 90), vy: fx(-220, -70), r: fx(1.5, 3), life: 0.8, floor: surface });
    }
    if (rightLevel >= round.rh) {
      rightLevel = round.rh;
      overflow = true;
      spill();
      finish();
    } else if (leftLevel <= marker) {
      finish();
    }
  }

  const flowing = phase === 'flowing';
  waveL += ((flowing ? 2.5 : 0.8) - waveL) * Math.min(1, dt * 2.5);
  waveR += ((flowing ? 4 : 0.8) - waveR) * Math.min(1, dt * (flowing ? 2.5 : 1.2));
  shake = Math.max(0, shake - dt);
  updateParticles(dt);
}

function updateHud() {
  if (mode === 'endless') {
    titleEl.textContent = `🪣 第 ${level} 關`;
    statusEl.textContent = '❤️'.repeat(lives) + '🖤'.repeat(MAX_LIVES - lives);
    extraEl.textContent = `最高：第 ${best} 關`;
  } else {
    const n = Math.min(dailyResults.length + (phase === 'result' || phase === 'dailyDone' ? 0 : 1), DAILY_ROUNDS);
    titleEl.textContent = phase === 'dailyDone' ? '📅 每日挑戰' : `📅 每日挑戰 ${n} / ${DAILY_ROUNDS}`;
    statusEl.textContent = dailyResults.map(r => OUTCOME[r].emoji).join('')
      + '⬜'.repeat(DAILY_ROUNDS - dailyResults.length);
    extraEl.textContent = dailyDate + (dailyPractice ? '（練習）' : '');
  }
  const ok = outcome === 'hit';
  actionBtn.textContent = {
    ready: '開始放水 ▶',
    aiming: '停！⏸',
    flowing: '放水中…',
    result: mode === 'daily'
      ? (dailyResults.length >= DAILY_ROUNDS ? '看結果 🏁' : '下一題 ▶')
      : (ok ? '下一關 ▶' : '再試一次 ↻'),
    over: '重新開始 ↻',
    dailyDone: '再玩一次（練習）↻',
  }[phase];
  actionBtn.disabled = phase === 'flowing';
  shareBtn.hidden = !(mode === 'daily' && phase === 'dailyDone' && savedDaily());
  modeBtns.forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  muteBtn.textContent = sound.muted ? '🔇' : '🔊';
}

async function share() {
  const res = savedDaily();
  if (!res) return;
  const hits = res.filter(r => r === 'hit').length;
  const text = `🪣 連通水桶 每日挑戰 ${dailyDate}\n${hits}/${DAILY_ROUNDS}\n${res.map(r => OUTCOME[r].emoji).join('')}`;
  if (navigator.share) {
    try {
      await navigator.share({ text });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    shareBtn.textContent = '已複製！✅';
    setTimeout(() => { shareBtn.textContent = '分享成績 📋'; }, 1500);
  } catch {
    prompt('複製以下文字分享：', text);
  }
}

// ---------- 繪圖 ----------

// 顏色來自 shared/style.css 的主題變數，切換主題時重新讀取
let C;
function loadColors() {
  C = {
    wall: cssVar('--wall'),
    water: cssVar('--water'),
    waterSoft: cssVar('--water-soft'),
    pipe: cssVar('--pipe'),
    stand: cssVar('--stand'),
    zone: cssVar('--zone'),
    zoneLine: cssVar('--zone-line'),
    marker: cssVar('--marker'),
    food: cssVar('--food'),
    text: cssVar('--text'),
    muted: cssVar('--muted'),
  };
}
loadColors();
document.addEventListener('themechange', loadColors);

function drawBucket(x, base, w, h) {
  ctx.strokeStyle = C.wall;
  ctx.lineWidth = 4;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(x, base - h);
  ctx.lineTo(x, base);
  ctx.lineTo(x + w, base);
  ctx.lineTo(x + w, base - h);
  ctx.stroke();
  // 刻度，每 20px 一格
  ctx.lineWidth = 1.5;
  ctx.globalAlpha = 0.5;
  for (let y = 20; y < h; y += 20) {
    ctx.beginPath();
    ctx.moveTo(x, base - y);
    ctx.lineTo(x + 7, base - y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

// 水面是兩個正弦波疊加，amp 越大晃得越厲害
function fillWater(x, base, w, from, to, amp, color, seed = 0) {
  if (to - from < 0.5) return;
  const a = Math.min(amp, (to - from) / 2);
  const surf = px => base - to
    + Math.sin(px * 0.09 + time * 5 + seed) * a
    + Math.sin(px * 0.21 - time * 3.3 + seed) * a * 0.4;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x + 2, base - from);
  for (let px = x + 2; px < x + w - 2; px += 4) ctx.lineTo(px, surf(px));
  ctx.lineTo(x + w - 2, surf(x + w - 2));
  ctx.lineTo(x + w - 2, base - from);
  ctx.closePath();
  ctx.fill();
}

function band(x, base, w, lo, hi) {
  ctx.fillStyle = C.zone;
  ctx.fillRect(x + 2, base - hi, w - 4, hi - lo);
  ctx.strokeStyle = C.zoneLine;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  for (const y of [lo, hi]) {
    ctx.beginPath();
    ctx.moveTo(x + 2, base - y);
    ctx.lineTo(x + w - 2, base - y);
    ctx.stroke();
  }
  ctx.setLineDash([]);
}

function drawPipe() {
  const { lx, lw, sx } = round;
  const x1 = lx + lw;
  const path = () => {
    ctx.beginPath();
    ctx.moveTo(x1, PIPE_Y);
    ctx.lineTo(sx, PIPE_Y);
    ctx.lineTo(sx, PIPE_Y + 14);
  };
  ctx.lineJoin = 'round';
  ctx.lineWidth = 12;
  ctx.strokeStyle = C.pipe;
  path();
  ctx.stroke();
  if (pipeWet) {
    ctx.lineWidth = 6;
    ctx.strokeStyle = phase === 'flowing' ? C.water : C.waterSoft;
    path();
    ctx.stroke();
  }
  // 閥門
  const open = phase === 'flowing';
  const vx = x1 + 34;
  ctx.fillStyle = open ? C.zoneLine : C.marker;
  ctx.beginPath();
  ctx.arc(vx, PIPE_Y, 9, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = C.stand;
  ctx.lineWidth = 3;
  ctx.beginPath();
  if (open) { ctx.moveTo(vx - 6, PIPE_Y); ctx.lineTo(vx + 6, PIPE_Y); }
  else { ctx.moveTo(vx, PIPE_Y - 6); ctx.lineTo(vx, PIPE_Y + 6); }
  ctx.stroke();
}

function drawStream() {
  if (phase !== 'flowing') return;
  const top = PIPE_Y + 14;
  const bottom = GROUND - rightLevel;
  const wobble = Math.sin(time * 40) * 0.8;
  ctx.fillStyle = C.water;
  ctx.fillRect(round.sx - 2.5 + wobble, top, 5, bottom - top);
}

function drawParticles() {
  for (const p of particles) {
    if (p.kind === 'confetti') {
      ctx.save();
      ctx.globalAlpha = Math.min(1, p.life * 2);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    } else {
      ctx.fillStyle = C.water;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawText(text, y, size, color = C.text, weight = 600) {
  ctx.fillStyle = color;
  ctx.font = `${weight} ${size}px system-ui, "PingFang TC", sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText(text, W / 2, y);
}

function drawDailySummary() {
  const official = savedDaily();
  const hits = dailyResults.filter(r => r === 'hit').length;
  drawText(`📅 每日挑戰 ${dailyDate}`, 90, 22);
  drawText(`${hits} / ${DAILY_ROUNDS}`, 175, 64, C.zoneLine, 800);
  drawText(dailyResults.map(r => OUTCOME[r].emoji).join(''), 240, 30);
  if (dailyPractice) {
    const off = official ? official.filter(r => r === 'hit').length : 0;
    drawText(`這是練習成績，今天的正式成績是 ${off} / ${DAILY_ROUNDS}`, 300, 16, C.muted, 400);
  } else {
    drawText('🟩 命中　🟨 太少　🟥 太多　💦 溢出', 300, 15, C.muted, 400);
  }
  drawText('明天會有新的題目，記得再來挑戰！', 340, 16, C.muted, 400);
}

function draw() {
  ctx.clearRect(0, 0, W, H);
  ctx.save();
  if (shake > 0) {
    const s = shake * 14;
    ctx.translate(fx(-s, s), fx(-s, s));
  }

  if (phase === 'dailyDone') {
    drawDailySummary();
    drawParticles();
    ctx.restore();
    return;
  }

  const { lx, lw, lh, rx, rw, rh, w0 } = round;

  // 地面與高台
  ctx.fillStyle = C.stand;
  ctx.fillRect(lx + lw * 0.2, STAND + 2, lw * 0.6, GROUND - STAND);
  ctx.fillRect(0, GROUND + 2, W, H - GROUND);

  drawPipe();

  // 左桶的水；瞄準時把紅線以上「將放掉的水」畫淡一點
  if (phase === 'aiming') {
    fillWater(lx, STAND, lw, 0, marker, 0, C.water);
    fillWater(lx, STAND, lw, marker, w0, waveL, C.waterSoft);
  } else {
    fillWater(lx, STAND, lw, 0, leftLevel, waveL, C.water);
  }

  // 右桶安全區間、水柱與水
  band(rx, GROUND, rw, round.lo, round.hi);
  drawStream();
  fillWater(rx, GROUND, rw, 0, rightLevel, waveR, C.water, 2);

  // 結果出來後，在左桶標出正確的停止範圍
  if (phase === 'result' || phase === 'over') {
    band(lx, STAND, lw, w0 - round.dropHi, w0 - round.dropLo);
  }

  drawBucket(lx, STAND, lw, lh);
  drawBucket(rx, GROUND, rw, rh);
  drawParticles();

  // 紅色刻度線
  if (phase !== 'ready') {
    const y = STAND - marker;
    ctx.strokeStyle = C.marker;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(lx - 14, y);
    ctx.lineTo(lx + lw + 6, y);
    ctx.stroke();
    ctx.fillStyle = C.marker;
    ctx.beginPath();
    ctx.moveTo(lx - 14, y - 7);
    ctx.lineTo(lx - 4, y);
    ctx.lineTo(lx - 14, y + 7);
    ctx.fill();
  }

  drawText(message, 28, 17);
  ctx.restore();
}

let last = performance.now();
function loop(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  update(dt);
  draw();
  requestAnimationFrame(loop);
}

actionBtn.addEventListener('click', () => { act(); actionBtn.blur(); });
shareBtn.addEventListener('click', () => { share(); shareBtn.blur(); });
muteBtn.addEventListener('click', () => {
  sound.muted = !sound.muted;
  store.set('mini-games-muted', sound.muted ? '1' : '0');
  if (sound.muted) sound.stopPour();
  updateHud();
  muteBtn.blur();
});
modeBtns.forEach(b => b.addEventListener('click', () => { setMode(b.dataset.mode); b.blur(); }));
canvas.addEventListener('pointerdown', () => {
  if (phase !== 'flowing' && phase !== 'dailyDone') act();
});
document.addEventListener('keydown', e => {
  if (e.key === ' ' || e.key === 'Enter') {
    e.preventDefault();
    if (phase !== 'flowing') act();
  }
});

setMode(mode);
requestAnimationFrame(loop);
