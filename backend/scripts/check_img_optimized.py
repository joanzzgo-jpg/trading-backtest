#!/usr/bin/env python3
"""守門員：static/img 裡的 PNG 不可以是「沒壓過的匯出檔」。不需服務跑著，約 10 秒。

2026-09-24 量到：7 張 PNG 合計 143.6 KB，用 oxipng 無損重壓後只要 88.6 KB ——
**省 54.9 KB（38%），而且解碼後像素逐位元相同**。其中 4 張在冷載關鍵路徑上
（bear / bear-full / icon-192 / cursor-wand），實測冷載 642.5 → 624.4 KB。
★ 圖片是**會一直被加進來**的東西（同 topbar 按鈕、同公告條目），而繪圖工具匯出的 PNG
  幾乎都帶著一堆沒用的 chunk 與未最佳化的濾波器 —— 沒人會記得每次手動壓。
★ 這種浪費**完全無聲**：圖片顯示正常、零錯誤，只是每個使用者都多付一次頻寬。

判準＝對每張 PNG 實際跑一次無損重壓，**還能再省超過 _SLACK 就算沒壓過**。
⚠ 門檻不可以訂太緊（那會叫狼來了）：不同 oxipng 版本結果會差幾個百分點，
  而「沒壓過的匯出檔」實測是 35~45% —— 取 12% 兩者差很遠，不會誤判。
⚠ 回傳碼 2＝沒裝 pyoxipng（測試不成立），不是通過。
⚠ 只驗無損那條路：**不可以**改成「用 256 色調色盤還能更小就算失敗」——
  那是有損的（漸層會出色帶），而這幾張是水彩風插畫。
"""
import glob, hashlib, io, os, sys

_SLACK = 0.12          # 還能再省 12% 以上 → 判定沒壓過
_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "frontend", "static", "img")

try:
    import oxipng
    from PIL import Image
except ImportError as e:
    print(f"⚠ 測試不成立：缺少 {e.name}（pip install pyoxipng pillow）")
    sys.exit(2)

files = sorted(glob.glob(os.path.join(_DIR, "*.png")))
if len(files) < 3:
    print(f"⚠ 測試不成立：只找到 {len(files)} 張 PNG，路徑可能不對（{_DIR}）")
    sys.exit(2)

bad, tot_o, tot_n = [], 0, 0
for p in files:
    raw = open(p, "rb").read()
    try:
        out = oxipng.optimize_from_memory(raw, level=6, strip=oxipng.StripChunks.safe())
    except Exception as e:
        print(f"  {os.path.basename(p):<26} 壓縮失敗（跳過）：{type(e).__name__}")
        continue
    gain = (len(raw) - len(out)) / len(raw)
    tot_o += len(raw); tot_n += min(len(raw), len(out))
    mark = ""
    if gain > _SLACK:
        # 只有真的無損才算數 —— 不然報的「還能省」是假的
        a = Image.open(io.BytesIO(raw)).convert("RGBA").tobytes()
        b = Image.open(io.BytesIO(out)).convert("RGBA").tobytes()
        if hashlib.md5(a).hexdigest() == hashlib.md5(b).hexdigest():
            bad.append(f"{os.path.basename(p)}：還能無損再省 {gain*100:.0f}%"
                       f"（{len(raw)/1024:.1f} → {len(out)/1024:.1f} KB）")
            mark = "  ← 沒壓過"
    print(f"  {os.path.basename(p):<26} {len(raw)/1024:6.1f} KB   還能再省 {gain*100:4.1f}%{mark}")

print(f"\n{len(files)} 張合計 {tot_o/1024:.1f} KB")
if bad:
    print("\n✗ 有沒壓過的 PNG（跑這段修好）：")
    for b in bad:
        print("  " + b)
    print("\n  cd /Users/noah/trading && .venv312/bin/python -c \""
          "import oxipng,glob;[open(p,'wb').write(oxipng.optimize_from_memory("
          "open(p,'rb').read(),level=6,strip=oxipng.StripChunks.safe())) "
          "for p in glob.glob('frontend/static/img/*.png')]\"")
    sys.exit(1)
print("✓ 所有 PNG 都已無損壓到位")
