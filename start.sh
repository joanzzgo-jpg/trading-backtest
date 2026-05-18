#!/bin/bash
cd "$(dirname "$0")"

echo "📦 安裝依賴..."
pip install -r requirements.txt -q

echo "🔧 打包 JS..."
python3 - <<'PYEOF'
import sys
from pathlib import Path

js = Path("frontend/static/js")
files = ["config","utils","charts","draw","ticker","winrate","render","realtime","replay","ui","ai_research","main"]
parts = []
for name in files:
    f = js / f"{name}.js"
    if f.exists():
        parts.append(f.read_text(encoding="utf-8"))
    else:
        print(f"  ⚠ {name}.js not found", file=sys.stderr)

content = "\n".join(parts)

try:
    import rjsmin
    content = rjsmin.jsmin(content)
    print(f"  ✓ minified → {len(content)//1024} KB")
except ImportError:
    print("  ⚠ rjsmin 未安裝，跳過壓縮")

(js / "app.bundle.js").write_text(content, encoding="utf-8")
print("  ✓ app.bundle.js 完成")
PYEOF

echo "🚀 啟動回測系統..."
cd backend && uvicorn main:app --host 0.0.0.0 --port 8000 --reload
