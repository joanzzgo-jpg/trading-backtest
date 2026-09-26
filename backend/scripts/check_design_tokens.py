#!/usr/bin/env python3
"""守門員：style.css 的圓角／字級／間距必須走那一組刻度。不需服務跑著，約 2 秒。

2026-09-24 使用者：「整體配置想要跟 apple 美學一樣」／2026-09-26「持續對整體介面 apple 美學化」。稽核發現真正的問題不是配色，
而是**沒有 token 系統**：圓角 28 種散在 217 處、字級 24 種（含十種半像素 8.5/9.5/9.8/
10.5/11.5/12.5/13.9/15.5/16.2/18.5px）、間距 1~13px 奇偶混用。
「每個元件各自為政」正是一眼看得出不夠精緻的主因。收斂完之後需要有人擋住它慢慢長回去
—— 新元件只要有人隨手寫 `border-radius: 7px`，這套刻度就開始被侵蝕，而且**畫面上看不出來**，
要累積幾十處之後才又變成「說不上哪裡怪」。
★ 2026-09-26 同一個病在兩個新地方被抓到：**材質**（backdrop-filter 散了 13 種模糊值
   1/2/3/4/6/8/9/10/12/16/18/24px ＋ 4 種飽和度）與**動態曲線**（7 條只出現 1~2 次的
   一次性 cubic-bezier，外加同一條彈跳曲線被抄 16 遍）。Apple 兩者都只有一小組固定值
   （材質五級 ultraThin→ultraThick；動效詞彙小而一致）→ 一併收斂並納入這支守門員。

判準（直接讀 CSS 的宣告，不是看有沒有某個字串）：
  ① border-radius 不可出現裸 px（要走 var(--r-*)）；0 與 50% 例外（那是形狀不是尺寸）
  ② font-size 不可出現裸 px（要走 var(--t-*)）；em/clamp/inherit/revert 例外
  ③ padding/margin/gap 的 px 值必須落在偶數刻度上；1px（髮絲線）與 >32px（大留白）例外
  ④ backdrop-filter 必須走 var(--mat-*) 五級材質階梯；none 例外（2026-09-26 加）
  ⑤ cubic-bezier 只能出現在 --ease-* 的定義裡，其餘一律走 var(--ease-*)（2026-09-26 加）
  ⑥ 幾條**全域規則必須在最外層**（不可以被關進任何 @media）（2026-09-26 加）
     —— 我用腳本把 119 條 :hover 規則包進 @media (hover: hover) 時，掃描器沒認出
     一行寫完的 `@media (max-width:1180px) { .x { … } }`，結果把**鍵盤焦點那條規則
     整個關進手機斷點裡**（焦點環只剩窄螢幕有效）。大括號總數是平衡的、檔案也解析得過，
     CSS 不會報錯 —— 只有「那條規則在寬螢幕失效」這個行為變了。
     ★ 通則：**機械改寫 CSS 之後，要驗的不只是括號平衡，而是「規則還在原本的巢狀層級」。**
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
css_body = re.sub(r'--(?:r|t|e|mat|ease)-[a-z0-9-]+\s*:[^;]*;', '', css)
# 註解裡常引用舊值當說明（例：「blur(10px)：整片模糊會把…」）→ 整段拿掉再驗，否則會誤報
css_body = re.sub(r'/\*.*?\*/', '', css_body, flags=re.S)

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

for m in re.finditer(r'backdrop-filter\s*:\s*([^;{}]+?)\s*(?:!important)?\s*[;}]', css_body):
    v = " ".join(m.group(1).split())
    if "var(" in v or v.startswith("none"):
        continue
    bad["材質寫了裸值（應走 var(--mat-*)）"].append(v)

for m in re.finditer(r'cubic-bezier\([^)]*\)', css_body):
    bad["動態曲線寫了裸 cubic-bezier（應走 var(--ease-*)）"].append(m.group(0))

# ⑥ 全域規則不可被關進 @media：逐字掃描算每條規則的巢狀深度
_MUST_TOP = (":root", "button:focus-visible", "html, body")
def _depths(src):
    i, n, d, out = 0, len(src), 0, []
    while i < n:
        if src.startswith("/*", i):
            j = src.find("*/", i + 2); i = n if j < 0 else j + 2; continue
        c = src[i]
        if c == "{":
            k = max(src.rfind("}", 0, i), src.rfind("{", 0, i), src.rfind("*/", 0, i)) + 1
            out.append((" ".join(src[k:i].split()), d)); d += 1
        elif c == "}":
            d -= 1
        i += 1
    return out, d
_rules, _tail = _depths(css)
if _tail != 0:
    print(f"⚠ 測試不成立：大括號沒有平衡（掃到檔尾深度 {_tail}）"); sys.exit(2)
for _sel, _d in _rules:
    if _d == 0: continue
    for _m in _MUST_TOP:
        if _m in _sel:
            bad[f"全域規則被關進 @media（應在最外層）"].append(f"{_sel[:60]}　深度 {_d}")

total = sum(len(v) for v in bad.values())
scanned = len(re.findall(r'border-radius\s*:|font-size\s*:|backdrop-filter\s*:', css_body))
if scanned < 100:
    print(f"⚠ 測試不成立：只掃到 {scanned} 條宣告，檔案可能不對"); sys.exit(2)

print(f"掃描 {scanned} 條圓角／字級／材質宣告")
if not bad:
    print("✓ 圓角、字級、間距、材質、動態曲線全部走刻度")
    sys.exit(0)
for k, v in bad.items():
    print(f"\n✗ {k}：{len(v)} 處")
    for x, n in collections.Counter(v).most_common(8):
        print(f"    {n}×  {x[:78]}")
print(f"\n合計 {total} 處偏離刻度。刻度定義在 style.css 的 :root："
      "\n   圓角 --r-xs/sm/md/lg/pill　字級 --t-2xs…--t-3xl　間距 2/4/6/8/10/12/14/16/20/24/28/32px"
      "\n   材質 --mat-ultra-thin/thin/regular/thick/ultra-thick　曲線 --ease-std/out/spring")
sys.exit(1)
