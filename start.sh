#!/bin/bash
cd "$(dirname "$0")"

echo "📦 安裝依賴..."
pip install -r requirements.txt -q

echo "🚀 啟動回測系統..."
cd backend && uvicorn main:app --host 0.0.0.0 --port 8000 --reload
