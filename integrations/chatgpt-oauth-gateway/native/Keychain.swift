import Foundation
import Security
import Darwin

// Secrets travel only through pipes, never argv or a temporary plaintext file.
// Generic password items are non-synchronizable and restricted to this Mac.
func emit(_ value: Any) {
  if let data = try? JSONSerialization.data(withJSONObject: value) {
    FileHandle.standardOutput.write(data)
  }
}

// Hold a kernel lock for the daemon lifetime. The file contains no credentials
// and is never unlinked, preventing two owners after concurrent crash recovery.
if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--lock" {
  let descriptor = open(CommandLine.arguments[2], O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
  guard descriptor >= 0, flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
    emit(["ok": false]); exit(1)
  }
  emit(["ok": true])
  FileHandle.standardOutput.write(Data("\n".utf8))
  _ = FileHandle.standardInput.readDataToEndOfFile()
  close(descriptor)
  exit(0)
}

do {
  let input = FileHandle.standardInput.readDataToEndOfFile()
  guard input.count <= 1_048_576,
        let request = try JSONSerialization.jsonObject(with: input) as? [String: Any],
        let operation = request["operation"] as? String,
        let service = request["service"] as? String,
        let account = request["account"] as? String,
        service.hasPrefix("org.affine-local.chatgpt-oauth-gateway"),
        account.count <= 200 else {
    emit(["ok": false, "code": "invalid_keychain_request"])
    exit(1)
  }
  let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service,
    kSecAttrAccount as String: account,
    kSecAttrSynchronizable as String: false
  ]
  switch operation {
  case "get":
    var match = query
    match[kSecReturnData as String] = true
    match[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(match as CFDictionary, &result)
    if status == errSecItemNotFound {
      emit(["ok": true, "value": NSNull()])
    } else if status == errSecSuccess, let data = result as? Data,
              let value = String(data: data, encoding: .utf8) {
      emit(["ok": true, "value": value])
    } else {
      emit(["ok": false, "status": Int(status)])
      exit(1)
    }
  case "set":
    guard let value = request["value"] as? String,
          let data = value.data(using: .utf8) else { exit(1) }
    let updates: [String: Any] = [kSecValueData as String: data]
    var status = SecItemUpdate(query as CFDictionary, updates as CFDictionary)
    if status == errSecItemNotFound {
      var item = query
      item[kSecValueData as String] = data
      item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
      status = SecItemAdd(item as CFDictionary, nil)
    }
    emit(["ok": status == errSecSuccess, "status": Int(status)])
    if status != errSecSuccess { exit(1) }
  case "delete":
    let status = SecItemDelete(query as CFDictionary)
    let ok = status == errSecSuccess || status == errSecItemNotFound
    emit(["ok": ok, "status": Int(status)])
    if !ok { exit(1) }
  default:
    emit(["ok": false, "code": "invalid_keychain_operation"])
    exit(1)
  }
} catch {
  emit(["ok": false, "code": "keychain_failure"])
  exit(1)
}
