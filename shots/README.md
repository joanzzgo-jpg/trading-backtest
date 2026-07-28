# shots — 交易紀錄原始素材（放這裡給 Claude 讀）

## 放什麼
- **截圖**：Pionex/幣安等的「倉位詳情」「歷史數據」畫面（.png/.jpg）
  - iPhone → AirDrop 到 Mac → 拖進這個資料夾
- **文字**：手機「實況文字」或網頁表格複製出來的純文字（.txt）
  - VS Code 新建檔案貼上再存檔（聊天輸入框貼不進去時走這條）

## 為什麼要放成檔案
免費的 OCR 工具（`scripts/ocr_table.swift`，用 macOS 內建 Vision 引擎）是命令列程式，
要讀得到磁碟上的檔案。貼在對話裡的圖它跑不到。

## 怎麼跑
```bash
swiftc -O scripts/ocr_table.swift -o /tmp/ocr_table   # 編一次就好
/tmp/ocr_table shots/你的截圖.png                      # 純文字（已還原表格欄列）
/tmp/ocr_table shots/你的截圖.png --json               # 每個字塊的座標與信心值
```

## 隱私
這個資料夾**不進版控**（見同層 .gitignore），檔案只留在你自己的電腦上。
