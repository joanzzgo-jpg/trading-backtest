// macOS 內建 OCR（Vision 框架）→ 表格文字 + 每個字塊的座標。
//
// 為什麼用這個：辨識交易截圖不需要付費的雲端模型。macOS 自帶的 Vision OCR 對印刷體
// （交易所表格就是）準確度很高、離線、免金鑰、零成本，而且它會回**每個文字塊的方框座標**，
// 所以可以照 x 座標還原「欄」、照 y 座標還原「列」——這正是雲端 OCR 常常做不好的部分。
//
// 用法：
//   swiftc -O scripts/ocr_table.swift -o /tmp/ocr_table   （編一次就好）
//   /tmp/ocr_table 圖片路徑 [--json]
// 輸出：預設是還原成表格的純文字；--json 則輸出每個字塊的 {text,x,y,w,h,conf}，給程式再加工。

import Foundation
import Vision
import AppKit

struct Box: Codable { let text: String; let x: Double; let y: Double; let w: Double; let h: Double; let conf: Double }

let args = CommandLine.arguments
guard args.count >= 2 else {
    FileHandle.standardError.write("用法: ocr_table <圖片路徑> [--json]\n".data(using: .utf8)!)
    exit(2)
}
let path = args[1]
let asJSON = args.contains("--json")

guard let img = NSImage(contentsOfFile: path),
      let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write("讀不到圖片: \(path)\n".data(using: .utf8)!)
    exit(1)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate                 // 準確優先（交易數字看錯一位就毀了）
request.usesLanguageCorrection = false               // ★關掉語言校正：它會把 118240.5 之類的數字「修」壞
request.recognitionLanguages = ["zh-Hant", "zh-Hans", "en-US"]   // 交易所介面常見中英混排

let handler = VNImageRequestHandler(cgImage: cg, options: [:])
do { try handler.perform([request]) } catch {
    FileHandle.standardError.write("OCR 失敗: \(error)\n".data(using: .utf8)!)
    exit(1)
}

let W = Double(cg.width), H = Double(cg.height)
var boxes: [Box] = []
for obs in (request.results ?? []) {
    guard let top = obs.topCandidates(1).first else { continue }
    let bb = obs.boundingBox                          // Vision 是正規化座標、原點在左下
    boxes.append(Box(text: top.string,
                     x: Double(bb.minX) * W,
                     y: (1 - Double(bb.maxY)) * H,    // 轉成「原點在左上」的一般影像座標
                     w: Double(bb.width) * W,
                     h: Double(bb.height) * H,
                     conf: Double(top.confidence)))
}

if asJSON {
    let out = try! JSONEncoder().encode(boxes)
    print(String(data: out, encoding: .utf8)!)
    exit(0)
}

// 純文字模式：依 y 分列（同一列的字塊 y 相近），列內依 x 排序 → 還原閱讀順序
let sorted = boxes.sorted { $0.y < $1.y }
var rows: [[Box]] = []
for b in sorted {
    let tol = max(b.h * 0.6, 6)                       // 同列容忍：以字高為準，避免固定像素在不同縮放下失準
    if var last = rows.last, let ref = last.first, abs(ref.y - b.y) <= tol {
        last.append(b); rows[rows.count - 1] = last
    } else {
        rows.append([b])
    }
}
for row in rows {
    print(row.sorted { $0.x < $1.x }.map { $0.text }.joined(separator: "\t"))
}
