import AppKit
import Security
import CryptoKit
import Foundation

// expectedRuntimeHash is injected at build time from the reviewed runtime manifest.
// This executable, not a shell or Python interpreter, is the Keychain trusted app.
enum Failure: Error { case invalid, locked, cancelled }
let fm = FileManager.default
let executable = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
let directory = executable.deletingLastPathComponent()

func sha(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}
func object(_ url: URL) throws -> [String: Any] {
    guard let value = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any] else {
        throw Failure.invalid
    }
    return value
}
func text(_ value: [String: Any], _ name: String) throws -> String {
    guard let result = value[name] as? String, !result.isEmpty else { throw Failure.invalid }
    return result
}
func runtime(requireInstalled: Bool = true) throws -> [String: Any] {
    let manifestURL = directory.appendingPathComponent("runtime.json")
    guard sha(try Data(contentsOf: manifestURL)) == expectedRuntimeHash else { throw Failure.invalid }
    let value = try object(manifestURL)
    let expectedDirectory = try text(value, "install_dir")
    if requireInstalled && expectedDirectory != directory.path { throw Failure.invalid }
    guard let files = value["files"] as? [String: String] else { throw Failure.invalid }
    for (name, hash) in files {
        guard !name.contains("/"), name != ".", name != ".." else { throw Failure.invalid }
        let url = directory.appendingPathComponent(name)
        guard url.resolvingSymlinksInPath().path == url.path,
              sha(try Data(contentsOf: url)) == hash else { throw Failure.invalid }
    }
    guard sha(try Data(contentsOf: URL(fileURLWithPath: text(value, "python")))) ==
            (try text(value, "python_sha256")) else { throw Failure.invalid }
    return value
}
func query(_ config: [String: Any]) throws -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword,
     kSecAttrService as String: try text(config, "service"),
     kSecAttrAccount as String: try text(config, "account"),
     kSecAttrSynchronizable as String: false]
}
func verifyStatus(_ status: OSStatus) throws {
    if status == errSecInteractionNotAllowed || status == errSecAuthFailed || status == errSecNotAvailable {
        throw Failure.locked
    }
    guard status == errSecSuccess else { throw Failure.invalid }
}
func writeMetadata(_ value: [String: Any], to url: URL) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .prettyPrinted])
    try data.write(to: url, options: [.atomic])
    try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
}
func enrollmentView() -> (NSView, NSSecureTextField) {
    let view = NSView(frame: NSRect(x: 0, y: 0, width: 460, height: 180))
    let explanation = NSTextField(wrappingLabelWithString:
        "服务：灵眸（api.lmuai.ai）\n模型：GPT-6.1 Terra\n密钥保存在本机钥匙串，只供这个固定审阅程序读取。\n保存密钥不会批准任何模型请求；每次审阅仍需单独批准。")
    explanation.frame = NSRect(x: 0, y: 70, width: 460, height: 104)
    explanation.font = NSFont.systemFont(ofSize: 13)
    view.addSubview(explanation)
    let input = NSSecureTextField(frame: NSRect(x: 0, y: 32, width: 460, height: 28))
    input.placeholderString = "专用审阅密钥"
    view.addSubview(input)
    let foot = NSTextField(labelWithString: "可随时暂停队列；移除配置时删除对应钥匙串项。")
    foot.frame = NSRect(x: 0, y: 0, width: 460, height: 24)
    foot.font = NSFont.systemFont(ofSize: 11)
    foot.textColor = .secondaryLabelColor
    view.addSubview(foot)
    return (view, input)
}
func enroll(_ config: [String: Any]) throws {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let alert = NSAlert()
    alert.messageText = "设置独立审阅密钥"
    alert.informativeText = "首次设置后，普通审阅不再需要重复打开终端输入密钥。"
    alert.addButton(withTitle: "保存到钥匙串")
    alert.addButton(withTitle: "取消")
    let (view, input) = enrollmentView()
    alert.accessoryView = view
    alert.window.initialFirstResponder = input
    app.activate(ignoringOtherApps: true)
    guard alert.runModal() == .alertFirstButtonReturn else { throw Failure.cancelled }
    let secret = input.stringValue
    input.stringValue = ""
    guard secret.utf8.count >= 12 && secret.utf8.count <= 1024 &&
            secret.utf8.allSatisfy({ $0 >= 33 && $0 <= 126 }) else { throw Failure.invalid }
    var trusted: SecTrustedApplication?
    try verifyStatus(SecTrustedApplicationCreateFromPath(executable.path, &trusted))
    guard let trustedApp = trusted else { throw Failure.invalid }
    var access: SecAccess?
    try verifyStatus(SecAccessCreate("Arcfold 独立审阅密钥" as CFString, [trustedApp] as CFArray, &access))
    guard let restrictedAccess = access else { throw Failure.invalid }
    var item = try query(config)
    item[kSecAttrAccess as String] = restrictedAccess
    item[kSecValueData as String] = Data(secret.utf8)
    item[kSecAttrLabel as String] = "Arcfold 独立审阅专用密钥"
    let added = SecItemAdd(item as CFDictionary, nil)
    if added == errSecDuplicateItem {
        // Recover a successful Keychain write whose metadata write was interrupted.
        // Do not replace an existing different credential.
        var lookup = try query(config)
        lookup[kSecReturnData as String] = true
        lookup[kSecMatchLimit as String] = kSecMatchLimitOne
        var existing: CFTypeRef?
        try verifyStatus(SecItemCopyMatching(lookup as CFDictionary, &existing))
        guard let data = existing as? Data, data == Data(secret.utf8) else { throw Failure.invalid }
    } else { try verifyStatus(added) }
    try writeMetadata(["service": try text(config, "service"), "account": try text(config, "account"),
                       "key_id": sha(Data(secret.utf8))],
                      to: directory.appendingPathComponent("credential.json"))
}
func loadSecret(_ config: [String: Any]) throws -> String {
    SecKeychainSetUserInteractionAllowed(false)
    var item = try query(config)
    item[kSecReturnData as String] = true
    item[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    try verifyStatus(SecItemCopyMatching(item as CFDictionary, &result))
    guard let data = result as? Data, let secret = String(data: data, encoding: .utf8) else { throw Failure.invalid }
    let metadata = try object(directory.appendingPathComponent("credential.json"))
    guard sha(data) == (try text(metadata, "key_id")) else { throw Failure.invalid }
    return secret
}
func runWorker(_ config: [String: Any], mode: String, path: String) throws {
    let run = URL(fileURLWithPath: path).standardizedFileURL
    let allowed = URL(fileURLWithPath: try text(config, "state_root"))
        .appendingPathComponent(try text(config, "repo")).appendingPathComponent("prs").standardizedFileURL
    guard run.path.hasPrefix(allowed.path + "/"), run.resolvingSymlinksInPath().path == run.path else {
        throw Failure.invalid
    }
    let packet = try object(run.appendingPathComponent("request.json"))
    guard try text(packet, "provider") == "lmuai",
          let target = packet["target"] as? [String: Any],
          try text(target, "repo") == text(config, "repo") else { throw Failure.invalid }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: try text(config, "python"))
    process.arguments = ["-I", "-B", directory.appendingPathComponent("review_native_worker.py").path, run.path, mode]
    process.environment = ["PATH": try text(config, "path"), "LANG": "en_US.UTF-8",
                           "ARCFOLD_REVIEW_API_KEY": try loadSecret(config)]
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    try process.run()
    process.environment = nil
    process.waitUntilExit()
    guard process.terminationStatus == 0 else { throw Failure.invalid }
}
func renderPreview(_ path: String) throws {
    _ = NSApplication.shared
    let (content, _) = enrollmentView()
    let canvas = NSView(frame: NSRect(x: 0, y: 0, width: 540, height: 330))
    canvas.wantsLayer = true
    canvas.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
    let title = NSTextField(labelWithString: "设置独立审阅密钥")
    title.font = NSFont.boldSystemFont(ofSize: 20)
    title.frame = NSRect(x: 40, y: 277, width: 460, height: 30)
    canvas.addSubview(title)
    content.frame.origin = NSPoint(x: 40, y: 78)
    canvas.addSubview(content)
    let save = NSButton(title: "保存到钥匙串", target: nil, action: nil)
    save.bezelStyle = .rounded
    save.frame = NSRect(x: 354, y: 25, width: 148, height: 34)
    canvas.addSubview(save)
    let cancel = NSButton(title: "取消", target: nil, action: nil)
    cancel.bezelStyle = .rounded
    cancel.frame = NSRect(x: 252, y: 25, width: 90, height: 34)
    canvas.addSubview(cancel)
    guard let bitmap = canvas.bitmapImageRepForCachingDisplay(in: canvas.bounds) else { throw Failure.invalid }
    canvas.cacheDisplay(in: canvas.bounds, to: bitmap)
    guard let png = bitmap.representation(using: .png, properties: [:]) else { throw Failure.invalid }
    try png.write(to: URL(fileURLWithPath: path))
}

do {
    let args = Array(CommandLine.arguments.dropFirst())
    guard let mode = args.first else { throw Failure.invalid }
    if mode == "render-preview" && args.count == 2 {
        try renderPreview(args[1]) // synthetic UI only: no Keychain/network/config access
    } else if mode == "verify" && args.count == 1 {
        _ = try runtime(requireInstalled: false)
    } else {
        let config = try runtime()
        if mode == "enroll" && args.count == 1 { try enroll(config) }
        else if ["dispatch", "settle", "observe"].contains(mode) && args.count == 2 {
            try runWorker(config, mode: mode, path: args[1])
        } else if mode == "remove" && args.count == 1 {
            SecKeychainSetUserInteractionAllowed(false)
            let result = SecItemDelete(try query(config) as CFDictionary)
            if result != errSecItemNotFound { try verifyStatus(result) }
            try? fm.removeItem(at: directory.appendingPathComponent("credential.json"))
        } else { throw Failure.invalid }
    }
} catch Failure.locked {
    exit(77)
} catch Failure.cancelled {
    exit(76)
} catch {
    // Do not print credentials, underlying error objects, or arbitrary provider content.
    fputs("本机审阅操作未完成，请核对配置与权限。\n", stderr)
    exit(1)
}

