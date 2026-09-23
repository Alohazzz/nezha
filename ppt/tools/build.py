"""Assemble ppt/index.html from the Swiss template + slides + notes + local assets."""
import io, os, re

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PPT = os.path.join(ROOT, "ppt")
TOOLS = os.path.join(PPT, "tools")
OUT_HTML = os.path.join(PPT, "index.html")

# 模板来源：优先仓库内的本地快照（不提交，见 .gitignore），否则回落到已安装的 skill。
# guizang-ppt-skill 以 AGPL-3.0 分发，其 template-swiss.html 不随本仓库再分发。
TPL_CANDIDATES = [
    os.path.join(TOOLS, "template-swiss.pristine.html"),
    os.path.join(os.path.expanduser("~"), ".agents", "skills", "guizang-ppt-skill", "assets", "template-swiss.html"),
    os.path.join(os.path.expanduser("~"), ".zcode", "skills", "guizang-ppt-skill", "assets", "template-swiss.html"),
]
TPL_SRC = next((p for p in TPL_CANDIDATES if os.path.exists(p)), None)
if not TPL_SRC:
    raise SystemExit(
        "找不到瑞士风模板 template-swiss.html。请先安装 guizang-ppt-skill，"
        "或把模板复制到 ppt/tools/template-swiss.pristine.html。"
    )

def read(p):
    with io.open(p, encoding="utf-8") as f:
        return f.read()

html = read(TPL_SRC)
slides = read(os.path.join(TOOLS, "slides.html")).strip()
notes = read(os.path.join(TOOLS, "notes.js")).strip()

TITLE = "哪吒 Nezha · 三头六臂，并发编程 — 内部交付汇报"

# ---------- 1. title ----------
html, n = re.subn(r"<title>.*?</title>", f"<title>{TITLE}</title>", html, count=1, flags=re.S)
assert n == 1, "title not replaced"

# ---------- 2. local fonts（Google Fonts 在本环境不可达，改自托管 Inter） ----------
google_links = re.compile(r'\n?<link rel="preconnect"[^>]*>\n?|<link href="https://fonts\.googleapis\.com[^>]*>\n?')
html, n = google_links.subn("", html)
assert n >= 2, f"expected font links removed, got {n}"

FONT_FACE = """
  /* ============ 自托管 Inter（离线可用；Google Fonts 常被墙） ============
     中文回落到 PingFang SC / 微软雅黑，见 --sans-zh */
  @font-face{font-family:"Inter";font-style:normal;font-weight:200;font-display:swap;
    src:url("assets/fonts/inter-latin-ext-200.woff2") format("woff2");
    unicode-range:U+0100-02AF,U+0304,U+0308,U+0329,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF;}
  @font-face{font-family:"Inter";font-style:normal;font-weight:200;font-display:swap;
    src:url("assets/fonts/inter-latin-200.woff2") format("woff2");
    unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD;}
  @font-face{font-family:"Inter";font-style:normal;font-weight:300;font-display:swap;
    src:url("assets/fonts/inter-latin-ext-300.woff2") format("woff2");
    unicode-range:U+0100-02AF,U+0304,U+0308,U+0329,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF;}
  @font-face{font-family:"Inter";font-style:normal;font-weight:300;font-display:swap;
    src:url("assets/fonts/inter-latin-300.woff2") format("woff2");
    unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD;}
  @font-face{font-family:"Inter";font-style:normal;font-weight:400;font-display:swap;
    src:url("assets/fonts/inter-latin-ext-400.woff2") format("woff2");
    unicode-range:U+0100-02AF,U+0304,U+0308,U+0329,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF;}
  @font-face{font-family:"Inter";font-style:normal;font-weight:400;font-display:swap;
    src:url("assets/fonts/inter-latin-400.woff2") format("woff2");
    unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD;}
  @font-face{font-family:"Inter";font-style:normal;font-weight:500;font-display:swap;
    src:url("assets/fonts/inter-latin-ext-500.woff2") format("woff2");
    unicode-range:U+0100-02AF,U+0304,U+0308,U+0329,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF;}
  @font-face{font-family:"Inter";font-style:normal;font-weight:500;font-display:swap;
    src:url("assets/fonts/inter-latin-500.woff2") format("woff2");
    unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD;}
  @font-face{font-family:"Inter";font-style:normal;font-weight:600;font-display:swap;
    src:url("assets/fonts/inter-latin-ext-600.woff2") format("woff2");
    unicode-range:U+0100-02AF,U+0304,U+0308,U+0329,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF;}
  @font-face{font-family:"Inter";font-style:normal;font-weight:600;font-display:swap;
    src:url("assets/fonts/inter-latin-600.woff2") format("woff2");
    unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD;}

"""

# ---------- 3. 自定义组件样式（保持瑞士风：直角 / hairline / 单一 accent） ----------
EXTRA_CSS = """
  /* ============================================================
     ↓↓↓ 本 deck 私有组件 · Nezha 内部交付汇报
     严格遵守瑞士风硬规则：直角、无阴影、无渐变、单一 accent、字号越大越细
     ============================================================ */
  .sub-card{border-radius:0}                     /* 覆盖模板残留的 3px 圆角 */
  .mono{font-family:var(--mono);font-size:.92em;letter-spacing:.01em}

  /* 通用信息格：hairline 顶线 + 编号 + 标题 + 说明 */
  .nz-cell{border-top:1px solid var(--border-subtle);padding-top:1.8vh;
    display:flex;flex-direction:column;gap:1vh;min-width:0}
  .slide.dark .nz-cell{border-top-color:rgba(255,255,255,.24)}
  .nz-cell-ttl{font-family:var(--sans),var(--sans-zh);font-weight:400;
    font-size:max(18px,1.45vw);line-height:1.25;letter-spacing:-.015em}
  .nz-cell-desc{color:var(--text-secondary)}
  .slide.dark .nz-cell-desc{color:rgba(255,255,255,.78)}
  .nz-cell-tag,.nz-cell-foot{margin-top:auto;color:var(--text-helper)}
  .nz-cell-focus{border-top:2px solid var(--accent)}

  /* 纵向账单 KPI（S20） */
  .nz-ledger{display:flex;flex-direction:column;border-top:1px solid rgba(255,255,255,.3)}
  .ledger-row{display:grid;grid-template-columns:minmax(0,3fr) minmax(0,6.4fr) auto;
    gap:2vw;align-items:center;padding:1.7vh 0;
    border-bottom:1px solid rgba(255,255,255,.18)}
  .ledger-num{font-family:var(--sans);font-weight:200;font-size:min(6.8vw,11.6vh);
    line-height:.86;letter-spacing:-.045em;font-feature-settings:"tnum"}
  .nz-unit{font-size:.3em;font-weight:300;opacity:.6;margin-left:.14em;
    vertical-align:.5em;letter-spacing:0}
  .ledger-label{display:flex;flex-direction:column;gap:.6vh;min-width:0}
  .ledger-icon{width:2vw;height:2vw;min-width:26px;min-height:26px;
    stroke-width:1.4;color:var(--accent-bright)}

  /* S22 大图页的指标数字与短语 */
  .nz-s22-num{font-family:var(--sans);font-weight:200;font-size:min(4.2vw,7.2vh);
    line-height:.95;letter-spacing:-.04em;font-feature-settings:"tnum"}
  .nz-s22-num.accent{color:var(--accent)}
  .nz-s22-phrase{font-family:var(--sans),var(--sans-zh);font-weight:200;
    font-size:min(1.95vw,3.4vh);line-height:1.16;letter-spacing:-.02em;color:var(--accent)}

  .nz-two-col{display:grid;grid-template-columns:1fr 1fr;gap:3vw;align-items:start}
  .nz-ink-full{background:var(--ink);color:var(--paper);
    margin:0 -5vw;padding:3.2vh 5vw}
  .nz-ink-full .t-body{color:var(--paper)}

  .nz-fact{border-top:1px solid var(--border-subtle);padding-top:1.6vh;
    display:flex;flex-direction:column;gap:.9vh}

  /* 闭环步骤（S14 左列） */
  .nz-steps{display:flex;flex-direction:column;min-width:0}
  .nz-step{display:grid;grid-template-columns:2.6em minmax(0,6.4em) minmax(0,1fr);
    gap:1.4vw;align-items:baseline;padding:1.5vh 0;
    border-bottom:1px solid var(--border-subtle)}
  .nz-step-no{font-family:var(--mono);font-size:14px;font-weight:500;color:var(--accent)}
  .nz-step-name{font-family:var(--sans),var(--sans-zh);font-size:max(18px,1.45vw);
    font-weight:400;letter-spacing:-.015em;line-height:1.2}
  .nz-step-desc{font-family:var(--sans),var(--sans-zh);font-size:16px;font-weight:400;
    color:var(--text-secondary);line-height:1.5}

  /* 环形图示容器（S14 / S17 右列） */
  .nz-loop-stage{position:relative;display:grid;place-items:center;min-width:0}
  .nz-loop-center{position:absolute;inset:0;display:flex;flex-direction:column;
    align-items:center;justify-content:center;gap:.7vh;text-align:center;pointer-events:none}
  .nz-loop-center-ttl{font-family:var(--sans),var(--sans-zh);font-weight:200;
    font-size:min(2.4vw,4.2vh);line-height:1.1;letter-spacing:-.02em}

  /* ink 左栏 + 三力卡（S13） */
  .nz-ink-hero{background:var(--ink);color:var(--paper);padding:2.8vh 1.8vw;
    display:flex;flex-direction:column;gap:1.8vh;position:relative;
    overflow:hidden;min-height:0}
  .nz-force-num{font-family:var(--sans);font-weight:300;font-size:min(3.4vw,6vh);
    line-height:.9;letter-spacing:-.03em;color:var(--accent)}
  .nz-force-ttl{font-family:var(--sans),var(--sans-zh);font-weight:400;
    font-size:max(18px,1.45vw);line-height:1.25;letter-spacing:-.015em;margin-bottom:.7vh}

  /* 三层说明（S17 左列） */
  .nz-layer-list{display:flex;flex-direction:column;gap:2.4vh;min-width:0}
  .nz-layer{display:grid;grid-template-columns:auto minmax(0,1fr);gap:1.4vw;align-items:start}
  .nz-layer-key{width:8px;height:8px;background:rgba(255,255,255,.5);margin-top:.75em}
  .nz-layer-key.accent{width:12px;height:12px;background:var(--accent-bright)}

  .nz-take-ttl{font-family:var(--sans),var(--sans-zh);font-weight:400;
    font-size:max(18px,1.7vw);line-height:1.2;letter-spacing:-.015em;
    color:var(--text-primary);margin-bottom:1vh}
  .nz-take-ttl.accent{color:var(--accent)}
  .nz-em{font-weight:500}

  /* 11 · S16 六格：限制行高，避免卡片被拉高后卡内出现大块空洞 */
  .nz-grid-6t{grid-auto-rows:minmax(0,auto);align-content:start}

  /* 13 · S04 六格：控制 3×2 网格高度，避免卡片被撑高 */
  .nz-subgrid-tight{grid-template-rows:repeat(2,minmax(0,1fr));align-content:start;max-height:58vh}
  .nz-subgrid-tight .sub-card .desc{margin-top:1.4vh}

  /* IKB 半屏上的小字：抬高对比度，投屏可读 */
  .split-half > .half.b-accent .chrome-min{color:rgba(255,255,255,.82)}
  .split-half > .half.b-accent .t-meta{color:rgba(255,255,255,.82)}

  /* 暗色页分页点对比度：模板默认 .32 在黑底上过弱 */
  body.dark-bg #nav .dot{background:rgba(255,255,255,.52)}
  body.dark-bg #nav .dot:hover{background:rgba(255,255,255,.78)}

  /* 段落里 inline mono 与中文字号协调 */
  .t-body .mono,.t-body-sm .mono,.lead .mono,.desc .mono,
  .nz-cell-desc .mono,.layer-desc .mono{font-size:.94em}

  /* S22 大图页的页码角标：纸张底片，避免压在深色/文字密集的截图上看不清 */
  .canvas-card .chrome-min[style*="position:absolute"]{background:var(--paper)}
  /* 截图页页码角标下移到白区，避免压住证据 */
  .nz-marker-body{position:absolute;right:5vw;bottom:3.2vh;z-index:2}
  .nz-marker-body .chrome-min{margin-bottom:0}

  /* 反向闭环那一行：单独用 accent 与上方正向链路区分 */
  .nz-step-reentry{border-bottom:0;background:var(--grey-1);
    margin-top:1.2vh;padding:1.5vh 1.4vw}
  .nz-step-no.accent,.nz-step-name.accent,.nz-step-desc.accent{color:var(--accent)}
  .nz-step-desc.accent{font-weight:400}

"""

# ---------- 4. 注入字体 + 自定义 CSS 到 <style> 开头 ----------
anchor = re.search(r"(<style>\n)", html)
assert anchor, "<style> anchor not found"
html = html[:anchor.end()] + FONT_FACE + EXTRA_CSS + html[anchor.end():]

# ---------- 5. lucide 改本地优先 + CDN 兜底 ----------
lucide_local = (
    '<script src="assets/lucide.min.js" onerror="var s=document.createElement(\'script\');'
    "s.src='https://unpkg.com/lucide@0.469.0/dist/umd/lucide.min.js';"
    's.onload=function(){lucide.createIcons()};document.head.appendChild(s)"></script>'
)
html, n = re.subn(
    r'<script src="https://unpkg\.com/lucide@latest/dist/umd/lucide\.min\.js"></script>',
    lucide_local, html, count=1)
assert n == 1, "lucide script not replaced"

# ---------- 6. 替换示例 slides 区（<div id="deck"> 内全部内容） ----------
deck_open = html.index('<div id="deck">') + len('<div id="deck">')
deck_close = html.index('\n</div>\n\n<div id="nav"></div>')
html = html[:deck_open] + "\n\n" + slides + "\n" + html[deck_close:]

# ---------- 7. 替换 SPEAKER_NOTES ----------
notes_start = html.index('<script>\nconst SPEAKER_NOTES = [')
notes_anchor = html.index('</script>', notes_start) + len('</script>')
html = html[:notes_start] + "<script>\n" + notes + "\n</script>" + html[notes_anchor:]

with io.open(OUT_HTML, "w", encoding="utf-8", newline="\n") as f:
    f.write(html)

slides_n = len(re.findall(r'<section[^>]*class="[^"]*\bslide\b', html))
notes_n = notes.count("\n    id:")
print(f"template: {TPL_SRC}")
print(f"assembled ppt/index.html  {len(html)//1024}KB  slides={slides_n}  notes={notes_n}")
print("remaining [必填] placeholders:", html.count("必填"))
