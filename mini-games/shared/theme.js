// 主題切換：預設淺色，選擇記在 localStorage。
// 放在 <head> 裡同步載入，避免頁面先閃一下淺色再變深色。
(() => {
  const KEY = 'mini-games-theme';
  const root = document.documentElement;
  let theme = 'light';
  try { theme = localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light'; } catch {}
  root.dataset.theme = theme;

  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.createElement('button');
    btn.className = 'theme-toggle';
    const render = () => {
      btn.textContent = theme === 'dark' ? '☀️' : '🌙';
      btn.title = btn.ariaLabel = theme === 'dark' ? '切換淺色模式' : '切換深色模式';
    };
    btn.addEventListener('click', () => {
      theme = theme === 'dark' ? 'light' : 'dark';
      root.dataset.theme = theme;
      try { localStorage.setItem(KEY, theme); } catch {}
      render();
      btn.blur();
      // 讓 canvas 遊戲重畫
      document.dispatchEvent(new Event('themechange'));
    });
    render();
    document.body.append(btn);
  });
})();

// 讀取 CSS 變數，給 canvas 用
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
