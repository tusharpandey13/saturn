// Local OCR with Apple Vision. No network. Usage: ocr <input.pdf|image>... [--out <md>] [--name <label>]
// PDF pages are rendered with PDFKit at 300 dpi; images are read as-is.
// Writes markdown with per-page text and the average confidence per page.
import Foundation
import Vision
import PDFKit
import AppKit

let dpi: CGFloat = 300

func render(_ page: PDFPage) -> CGImage? {
    let box = page.bounds(for: .mediaBox)
    let s = dpi / 72
    let w = Int(box.width * s), h = Int(box.height * s)
    guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                              space: CGColorSpaceCreateDeviceRGB(),
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
    ctx.setFillColor(CGColor(gray: 1, alpha: 1)); ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
    ctx.scaleBy(x: s, y: s); ctx.translateBy(x: -box.minX, y: -box.minY)
    page.draw(with: .mediaBox, to: ctx)
    return ctx.makeImage()
}

func ocr(_ img: CGImage) -> (String, Double, Int) {
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.usesLanguageCorrection = true
    let supported = (try? req.supportedRecognitionLanguages()) ?? ["en-US"]
    req.recognitionLanguages = ["en-US", "hi-IN"].filter { supported.contains($0) }
    try? VNImageRequestHandler(cgImage: img, options: [:]).perform([req])
    let obs = req.results ?? []
    // Sort top-to-bottom, then left-to-right, so table rows stay together.
    let sorted = obs.sorted {
        let a = $0.boundingBox, b = $1.boundingBox
        if abs(a.midY - b.midY) > 0.008 { return a.midY > b.midY }
        return a.minX < b.minX
    }
    var lines: [String] = []; var cur = ""; var lastY: CGFloat = -1; var confs: [Double] = []
    for o in sorted {
        guard let c = o.topCandidates(1).first else { continue }
        confs.append(Double(c.confidence))
        if lastY >= 0 && abs(o.boundingBox.midY - lastY) <= 0.008 { cur += "   " + c.string }
        else { if !cur.isEmpty { lines.append(cur) }; cur = c.string; lastY = o.boundingBox.midY }
    }
    if !cur.isEmpty { lines.append(cur) }
    let avg = confs.isEmpty ? 0 : confs.reduce(0, +) / Double(confs.count)
    return (lines.joined(separator: "\n"), avg, confs.count)
}

var args = Array(CommandLine.arguments.dropFirst())
var outPath: String? = nil; var name: String? = nil
if let i = args.firstIndex(of: "--out") { outPath = args[i + 1]; args.removeSubrange(i...i + 1) }
if let i = args.firstIndex(of: "--name") { name = args[i + 1]; args.removeSubrange(i...i + 1) }
guard !args.isEmpty else { FileHandle.standardError.write("usage: ocr <pdf|images...> [--out file.md] [--name label]\n".data(using: .utf8)!); exit(2) }

var pages: [(String, CGImage, String?)] = []   // label, image, text layer
for path in args {
    let url = URL(fileURLWithPath: path)
    if let doc = PDFDocument(url: url) {
        for i in 0..<doc.pageCount {
            guard let p = doc.page(at: i), let img = render(p) else { continue }
            let tl = p.string?.trimmingCharacters(in: .whitespacesAndNewlines)
            pages.append(("\(i + 1)", img, (tl?.isEmpty ?? true) ? nil : tl))
        }
    } else if let ns = NSImage(contentsOf: url), let img = ns.cgImage(forProposedRect: nil, context: nil, hints: nil) {
        pages.append((url.lastPathComponent, img, nil))
    } else { FileHandle.standardError.write("skip (unreadable): \(path)\n".data(using: .utf8)!) }
}

let label = name ?? URL(fileURLWithPath: args[0]).lastPathComponent
var md = "# OCR: \(label)\n\nEngine: Apple Vision (VNRecognizeTextRequest, accurate, language correction on), local only, \(Int(dpi)) dpi.\n"
md += "agent-verified: no  <!-- set to yes/partial after a human/agent checks key values against the page images -->\n\n"
md += "| Page | Avg confidence | Text layer | Note |\n|---|---|---|---|\n"
var bodies: [String] = []
for (lab, img, tl) in pages {
    let (text, avg, n) = ocr(img)
    let note = n == 0 ? "no text found (image/handwriting?)" : (avg < 0.5 ? "LOW confidence: verify against image" : "")
    md += "| \(lab) | \(String(format: "%.2f", avg)) | \(tl == nil ? "none" : "yes") | \(note) |\n"
    var b = "\n## Page \(lab)  (avg confidence \(String(format: "%.2f", avg)))\n\n```text\n\(text)\n```\n"
    if let tl = tl { b += "\nEmbedded text layer (cross-check):\n\n```text\n\(tl)\n```\n" }
    bodies.append(b)
}
md += bodies.joined()
let out = outPath ?? (args[0] + ".ocr.md")
try md.write(toFile: out, atomically: true, encoding: .utf8)
print("wrote \(out) (\(pages.count) pages)")
