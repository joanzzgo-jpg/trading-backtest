#!/usr/bin/env python3
"""守門員：style.css 的圓角／字級／間距必須走那一組刻度。不需服務跑著，約 2 秒。

2026-09-24 使用者：「整體配置想要跟 apple 美學一樣」。稽核發現真正的問題不是配色，
而是**沒有 token 系統**：圓角 28 種散在 217 處、字級 24 種（含十種半像素 8.5/9.5/9.8/
10.5/11.5/12.5/13.9/15.5/16.2/18.5px）、間距 1~13px 奇偶混用。
「每個元件各自為政」正是一眼看得出不夠精緻的主因。收斂完之後需要有人擋住它慢慢長回去
—— 新元件只要有人隨手寫 `border-radius: 7px`，這套刻度就開始被侵蝕，而且**畫面上看不出來**，
要累積幾十處之後才又變成「說不上哪裡怪」。

判準（直接讀 CSS 的宣告，不是看有沒有某個字串）：
  ① border-radius 不可出現裸 px（要走 var(--r-*)）；0 與 50% 例外（那是形狀不是尺寸）
  ② font-size 不可出現裸 px（要走 var(--t-*)）；em/clamp/inherit/revert 例外
  ③ padding/margin/gap 的 px 值必須落在偶數刻度上；1px（髮絲線）與 >32px（大留白）例外
⚠ 刻度定義本身（:root 那幾行）當然要寫裸值 → 以「宣告的是不是 --r-/--t- 變數」排除，
  不是用行號，否則 :root 一搬家守門員就壞了。
⚠ 回傳碼 2＝找不到 style.css 或解析不到任何宣告（測試不成立），不是通過。
"""
import os, re, sys, collections

CSS = os.path.join(os.path.dirname(__file__), "..", "..", "frontend", "static", "css", "style.css")
SPACING_OK = {0, 1, 2, 4, 6, 8, 10, 12, 14, 16, 20, 24, 28, 32}
PROPS = (r'(?:padding|margin|gap|row-gap|column-gap)'
         r'(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?')

if not os.path.exists(CSS):
    print(f"⚠ 測試不成立：找不到 {CSS}"); sys.exit(2)
css = open(CSS, encoding="utf-8").read()

# 刻度定義那幾行（--r-* / --t-* / --e-*）整段排除，它們本來就該寫裸值
css_body = re.sub(r'--(?:r|t|e)-[a-z0-9]+\s*:[^;]*;', '', css)

bad = collections.defaultdict(list)

for m in re.finditer(r'border-radius\s*:\s*([^;{}]+?)\s*(?:!important)?\s*[;}]', css_body):
    v = " ".join(m.group(1).split())
    if "var(" in v or v in ("0", "50%"):
        continue
    if re.search(r'\d+(?:\.\d+)?px', v):
        bad["圓角寫了裸 px（應走 var(--r-*)）"].append(v)

for m in re.finditer(r'font-size\s*:\s*([^;{}]+?)\s*(?:!important)?\s*[;}]', css_body):
    v = " ".join(m.group(1).split())
    if "var(" in v or "clamp(" in v or v.endswith("em") or v in ("inherit", "revert", "0"):
        continue
    if re.search(r'\d+(?:\.\d+)?px', v):
        bad["字級寫了裸 px（應走 var(--t-*)）"].append(v)

for m in re.finditer(r'\b' + PROPS + r'\s*:\s*([^;{}]+?)\s*(?:!important)?\s*[;}]', css_body):
    v = " ".join(m.group(1).split())
    if "var(" in v or "calc(" in v or "clamp(" in v:
        continue
    for tok in v.split():
        mm = re.fullmatch(r'(-?\d+(?:\.\d+)?)px', tok)
        if not mm:
            continue
        x = abs(float(mm.group(1)))
        if x > 32 or x in SPACING_OK:
            continue
        bad["間距不在偶數刻度上"].append(f"{v}  （{tok}）")

total = sum(len(v) for v in bad.values())
scanned = len(re.findall(r'border-radius\s*:|font-size\s*:', css_body))
if scanned < 100:
    print(f"⚠ 測試不成立：只掃到 {scanned} 條宣告，檔案可能不對"); sys.exit(2)

print(f"掃描 {scanned} 條圓角／字級宣告")
if not bad:
    print("✓ 圓角、字級、間距全部走刻度")
    sys.exit(0)
for k, v in bad.items():
    print(f"\n✗ {k}：{len(v)} 處")
    for x, n in collections.Counter(v).most_common(8):
        print(f"    {n}×  {x[:78]}")
print(f"\n合計 {total} 處偏離刻度。刻度定義在 style.css 的 :root："
      "\n   圓角 --r-xs/sm/md/lg/pill　字級 --t-2xs…--t-3xl　間距 2/4/6/8/10/12/14/16/20/24/28/32px")
sys.exit(1)
