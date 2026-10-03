const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');
const scoreEl = document.getElementById('score');
const bestEl = document.getElementById('best');
const startBtn = document.getElementById('start');

const GRID = 20;
const CELL = canvas.width / GRID;
const DIRS = {
  ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
  w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0],
};

let snake, dir, nextDir, food, score, timer, paused, over;
let best = 0;
try { best = Number(localStorage.getItem('snake-best')) || 0; } catch {}
bestEl.textContent = best;

function reset() {
  snake = [[10, 10], [9, 10], [8, 10]];
  dir = nextDir = [1, 0];
  score = 0;
  paused = false;
  over = false;
  scoreEl.textContent = 0;
  placeFood();
}

function placeFood() {
  do {
    food = [Math.floor(Math.random() * GRID), Math.floor(Math.random() * GRID)];
  } while (snake.some(([x, y]) => x === food[0] && y === food[1]));
}

function tick() {
  if (paused) return;
  dir = nextDir;
  const head = [snake[0][0] + dir[0], snake[0][1] + dir[1]];
  const hitWall = head[0] < 0 || head[1] < 0 || head[0] >= GRID || head[1] >= GRID;
  const hitSelf = snake.some(([x, y]) => x === head[0] && y === head[1]);
  if (hitWall || hitSelf) return gameOver();

  snake.unshift(head);
  if (head[0] === food[0] && head[1] === food[1]) {
    score++;
    scoreEl.textContent = score;
    placeFood();
    // 每吃 5 個加速一次
    if (score % 5 === 0) startLoop();
  } else {
    snake.pop();
  }
  draw();
}

function speed() {
  return Math.max(60, 140 - Math.floor(score / 5) * 10);
}

function startLoop() {
  clearInterval(timer);
  timer = setInterval(tick, speed());
}

function gameOver() {
  clearInterval(timer);
  timer = null;
  if (score > best) {
    best = score;
    bestEl.textContent = best;
    try { localStorage.setItem('snake-best', best); } catch {}
  }
  over = true;
  draw();
  startBtn.textContent = '再玩一次';
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = cssVar('--food');
  ctx.beginPath();
  ctx.arc((food[0] + .5) * CELL, (food[1] + .5) * CELL, CELL * .4, 0, Math.PI * 2);
  ctx.fill();
  const head = cssVar('--snake-head'), body = cssVar('--snake');
  snake.forEach(([x, y], i) => {
    ctx.fillStyle = i === 0 ? head : body;
    ctx.fillRect(x * CELL + 1, y * CELL + 1, CELL - 2, CELL - 2);
  });
  if (over) {
    ctx.fillStyle = cssVar('--overlay');
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = cssVar('--text');
    ctx.textAlign = 'center';
    ctx.font = 'bold 36px system-ui';
    ctx.fillText('Game Over', canvas.width / 2, canvas.height / 2);
    ctx.font = '18px system-ui';
    ctx.fillText(`分數 ${score}`, canvas.width / 2, canvas.height / 2 + 32);
  }
}

document.addEventListener('themechange', draw);

function turn(d) {
  // 不能直接回頭
  if (d && (d[0] !== -dir[0] || d[1] !== -dir[1])) nextDir = d;
}

document.addEventListener('keydown', e => {
  if (e.key === ' ' && timer) { paused = !paused; e.preventDefault(); return; }
  const d = DIRS[e.key] || DIRS[e.key.toLowerCase()];
  if (d) { e.preventDefault(); turn(d); }
});

let touchStart = null;
canvas.addEventListener('touchstart', e => {
  const t = e.touches[0];
  touchStart = [t.clientX, t.clientY];
});
canvas.addEventListener('touchend', e => {
  if (!touchStart) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - touchStart[0];
  const dy = t.clientY - touchStart[1];
  if (Math.max(Math.abs(dx), Math.abs(dy)) > 20) {
    turn(Math.abs(dx) > Math.abs(dy) ? [Math.sign(dx), 0] : [0, Math.sign(dy)]);
  }
  touchStart = null;
});

startBtn.addEventListener('click', () => {
  reset();
  draw();
  startLoop();
  startBtn.textContent = '重新開始';
  startBtn.blur();
});

reset();
draw();
