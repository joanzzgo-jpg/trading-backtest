#!/bin/bash
cd "$(dirname "$0")"

# 優先用 3.12 venv（與 Railway .python-version 鎖同版）；沒有就退回系統 python3
PY="python3"
UVICORN="uvicorn"
if [ -x ".venv312/bin/python" ]; then
  PY="$PWD/.venv312/bin/python"
  UVICORN="$PWD/.venv312/bin/uvicorn"
  echo "🐍 使用 .venv312 (Python 3.12)"
fi

echo "📦 安裝依賴..."
"$PY" -m pip install -r requirements.txt -q

echo "🔧 打包 JS..."
"$PY" - <<'PYEOF'
import sys
from pathlib import Path

js = Path("frontend/static/js")
files = ["config","utils","charts","draw","ticker","winrate","render","realtime","replay","ui","ai_research","signal_info","main"]
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
cd backend && "$UVICORN" main:app --host 0.0.0.0 --port 8000 --reload
