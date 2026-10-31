import AppKit
let logURL = URL(fileURLWithPath: CommandLine.arguments[1])
var lines: [String] = []
let t0 = ProcessInfo.processInfo.systemUptime
func w(_ s: String) { lines.append(String(format: "%.1f ", (ProcessInfo.processInfo.systemUptime - t0) * 1000) + s); try? lines.joined(separator: "\n").write(to: logURL, atomically: true, encoding: .utf8) }
class V: NSView {
  override var acceptsFirstResponder: Bool { true }
  override func scrollWheel(with e: NSEvent) {
    w("phase=\(e.phase.rawValue) momentum=\(e.momentumPhase.rawValue) dy=\(String(format: "%.2f", e.scrollingDeltaY)) precise=\(e.hasPreciseScrollingDeltas)")
  }
  override func draw(_ r: NSRect) {
    NSColor.windowBackgroundColor.setFill(); r.fill()
    let s = "Scroll Probe (Mac)\n\nFlick with two fingers here a few times,\nlike you did on framy, then close the window." as NSString
    s.draw(in: bounds.insetBy(dx: 40, dy: 150), withAttributes: [.font: NSFont.systemFont(ofSize: 20), .foregroundColor: NSColor.labelColor])
  }
}
class D: NSObject, NSApplicationDelegate {
  var win: NSWindow!
  func applicationDidFinishLaunching(_ n: Notification) {
    win = NSWindow(contentRect: NSRect(x: 200, y: 200, width: 700, height: 500), styleMask: [.titled, .closable], backing: .buffered, defer: false)
    win.title = "Scroll Probe"; win.contentView = V(); win.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
  }
  func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { true }
}
let app = NSApplication.shared; app.setActivationPolicy(.regular); let d = D(); app.delegate = d; app.run()
