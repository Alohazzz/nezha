/* 把一个副本注入测量脚本，用 Edge --dump-dom 读出每页的
   DOM/视觉溢出、底部空白、nav 安全线、标题间距。
   等价于 validate-swiss-deck.mjs 的 Playwright 测量项，用于没有 Playwright 的环境。 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const src = path.join(root, 'ppt', 'index.html');
const dst = path.join(root, 'ppt', '.shots', 'measure.html');

const probe = `
<script>
(function(){
  const out = [];
  const VH = window.innerHeight, VW = window.innerWidth;
  const NAV_TOP = VH * 0.93;                       // nav 在 97vh，安全线取 93vh
  const slides = [...document.querySelectorAll('section.slide')];
  const titleSel = ['.h-hero','.h-hero-zh','.h-xl','.h-xl-zh','.h-statement','.h-md','h1','h2'];
  slides.forEach((s, i) => {
    const sr = s.getBoundingClientRect();
    const body = s.querySelector('.canvas-card') || s;
    const kids = [...body.querySelectorAll('*')].filter(n => {
      if (n.closest('canvas.ascii-bg')) return false;
      if (n.tagName === 'CANVAS') return false;
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return false;
      return true;
    });
    let maxBottom = 0, minTop = 1e9, maxRight = 0, maxLeft = 0;
    kids.forEach(n => {
      const r = n.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return;
      if (r.bottom > maxBottom) maxBottom = r.bottom;
      if (r.top < minTop) minTop = r.top;
      if (r.right > maxRight) maxRight = r.right;
      if (r.left < maxLeft) maxLeft = r.left;
    });
    // 标题与下一个块之间的间距
    const titles = [...s.querySelectorAll(titleSel.join(','))].filter(n => n.textContent.trim());
    let titleGap = null, titleLabel = '';
    if (titles.length) {
      const t = titles[titles.length - 1];
      const tr = t.getBoundingClientRect();
      const isLocal = t.matches('.h-md, h3');
      let nearest = null;
      [...s.querySelectorAll('*')].forEach(n => {
        if (n === t || t.contains(n) || n.contains(t)) return;
        if (n.closest('canvas')) return;
        const r = n.getBoundingClientRect();
        if (r.height < 6 || r.width < 6) return;
        if (r.top < tr.bottom - 2) return;
        if (!nearest || r.top < nearest) nearest = r.top;
      });
      if (nearest) titleGap = Math.round(nearest - tr.bottom);
      titleLabel = t.tagName + '.' + String(t.className).split(' ').join('.');
    }
    out.push({
      i: i + 1,
      id: s.dataset.slideId || '',
      layout: s.dataset.layout || '',
      bottomOverflow: Math.round(maxBottom - VH),
      topUnderflow: Math.round(minTop),
      rightOverflow: Math.round(maxRight - VW),
      navBreach: Math.round(maxBottom - NAV_TOP),
      bottomWhitespace: Math.round(VH - maxBottom),
      activeHeightPct: Math.round((maxBottom / VH) * 100),
      titleGap,
      titleLabel
    });
  });
  document.title = 'MEASURE' + JSON.stringify({vh: VH, vw: VW, pages: out});
})();
</script>
`;

let html = fs.readFileSync(src, 'utf8');
html = html.replace('</body>', probe + '\n</body>');
fs.writeFileSync(dst, html);
console.log('wrote', dst);
