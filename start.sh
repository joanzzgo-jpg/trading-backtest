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

# ⚠ 這裡「不要」再自己打包 JS。
# bundle 的唯一權威清單在 backend/main.py 的 _build_js_bundle() names，
# 它會在 uvicorn import main:app 時自動比對 mtime 並重建（CSS / fx *.min.js 同理）。
# 舊版 start.sh 另存了一份硬寫的檔案清單，早已與 main.py 分家（少 15 支、多包已改動態載入的 draw），
# 且會自我固化：先寫出殘缺 bundle → main.py 看到 bundle 比來源新就跳過重建 → 前端安靜壞掉。

echo "🚀 啟動回測系統..."
cd backend && "$UVICORN" main:app --host 0.0.0.0 --port 8000 --reload
