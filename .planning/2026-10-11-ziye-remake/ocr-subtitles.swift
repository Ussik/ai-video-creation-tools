import Foundation
import Vision
import AppKit

let directory = CommandLine.arguments[1]
let names = try FileManager.default.contentsOfDirectory(atPath: directory).filter { $0.hasSuffix(".jpg") }.sorted()
var lines: [[String: Any]] = []
for (index, name) in names.enumerated() {
    let url = URL(fileURLWithPath: directory).appendingPathComponent(name)
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["zh-Hans", "en-US"]
    request.usesLanguageCorrection = false
    request.usesCPUOnly = true
    try VNImageRequestHandler(url: url).perform([request])
    let text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: " ")
    if !text.isEmpty { lines.append(["time": Double(index) + 0.5, "text": text]) }
}
let data = try JSONSerialization.data(withJSONObject: lines, options: [.prettyPrinted, .sortedKeys])
FileHandle.standardOutput.write(data)
