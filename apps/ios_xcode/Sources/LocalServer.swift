import Foundation
import Network

/// Минимальный HTTP-сервер для файлов из бандла (папка «www»), только на 127.0.0.1.
/// Нужен, чтобы в WKWebView работали ES-модули, Web Workers и звук (Range-запросы),
/// а адрес игры оставался одним и тем же (стабильный localStorage).
final class LocalServer {
    private let root: URL
    private let queue = DispatchQueue(label: "kc.localserver")
    private var listener: NWListener?

    init(root: URL) { self.root = root }

    /// Запускает сервер и вызывает `ready` с результатом (на главной очереди).
    func start(port: UInt16, ready: @escaping (Result<Void, Error>) -> Void) {
        do {
            let params = NWParameters.tcp
            params.requiredInterfaceType = .loopback
            let listener = try NWListener(using: params, on: NWEndpoint.Port(rawValue: port)!)
            listener.newConnectionHandler = { [weak self] conn in self?.handle(conn) }
            listener.stateUpdateHandler = { state in
                switch state {
                case .ready: DispatchQueue.main.async { ready(.success(())) }
                case .failed(let err): DispatchQueue.main.async { ready(.failure(err)) }
                default: break
                }
            }
            listener.start(queue: queue)
            self.listener = listener
        } catch {
            ready(.failure(error))
        }
    }

    func stop() { listener?.cancel(); listener = nil }

    // MARK: - HTTP

    private func handle(_ conn: NWConnection) {
        conn.start(queue: queue)
        receive(conn, buffer: Data())
    }

    private func receive(_ conn: NWConnection, buffer: Data) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 16 * 1024) { [weak self] data, _, done, error in
            guard let self else { return }
            var buf = buffer
            if let data { buf.append(data) }
            if let end = buf.range(of: Data("\r\n\r\n".utf8)) {
                let head = String(decoding: buf[buf.startIndex..<end.lowerBound], as: UTF8.self)
                self.respond(conn, head: head)
            } else if error != nil || done || buf.count > 64 * 1024 {
                conn.cancel()
            } else {
                self.receive(conn, buffer: buf)
            }
        }
    }

    private func respond(_ conn: NWConnection, head: String) {
        let lines = head.components(separatedBy: "\r\n")
        let parts = (lines.first ?? "").split(separator: " ")
        guard parts.count >= 2, parts[0] == "GET" || parts[0] == "HEAD" else {
            return send(conn, status: "405 Method Not Allowed", body: Data(), headers: [:])
        }
        let isHead = parts[0] == "HEAD"
        var path = String(parts[1]).components(separatedBy: "?")[0].removingPercentEncoding ?? "/"
        if path.hasSuffix("/") { path += "index.html" }

        // Защита от выхода за пределы папки.
        let file = root.appendingPathComponent(path).standardizedFileURL
        guard file.path.hasPrefix(root.standardizedFileURL.path),
              let data = try? Data(contentsOf: file, options: .mappedIfSafe)
        else {
            return send(conn, status: "404 Not Found", body: Data("Not found".utf8), headers: ["Content-Type": "text/plain"])
        }

        var headers = ["Content-Type": mime(file.pathExtension), "Accept-Ranges": "bytes", "Cache-Control": "no-cache"]
        let range = lines.first { $0.lowercased().hasPrefix("range:") }
        if let range, let (from, to) = parseRange(range, size: data.count) {
            headers["Content-Range"] = "bytes \(from)-\(to)/\(data.count)"
            let slice = data.subdata(in: from..<(to + 1))
            return send(conn, status: "206 Partial Content", body: isHead ? Data() : slice, headers: headers, length: slice.count)
        }
        send(conn, status: "200 OK", body: isHead ? Data() : data, headers: headers, length: data.count)
    }

    private func parseRange(_ line: String, size: Int) -> (Int, Int)? {
        guard size > 0, let eq = line.firstIndex(of: "=") else { return nil }
        let spec = line[line.index(after: eq)...].trimmingCharacters(in: .whitespaces)
        let bounds = spec.split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
        guard bounds.count == 2 else { return nil }
        if bounds[0].isEmpty, let n = Int(bounds[1]), n > 0 {            // bytes=-N (последние N)
            return (max(0, size - n), size - 1)
        }
        guard let from = Int(bounds[0]), from < size else { return nil }
        let to = Int(bounds[1]).map { min($0, size - 1) } ?? size - 1
        return to >= from ? (from, to) : nil
    }

    private func send(_ conn: NWConnection, status: String, body: Data, headers: [String: String], length: Int? = nil) {
        var out = "HTTP/1.1 \(status)\r\nConnection: close\r\nContent-Length: \(length ?? body.count)\r\n"
        for (k, v) in headers { out += "\(k): \(v)\r\n" }
        out += "\r\n"
        var data = Data(out.utf8)
        data.append(body)
        conn.send(content: data, completion: .contentProcessed { _ in conn.cancel() })
    }

    private func mime(_ ext: String) -> String {
        switch ext.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json", "webmanifest": return "application/json; charset=utf-8"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "svg": return "image/svg+xml"
        case "webp": return "image/webp"
        case "mp3": return "audio/mpeg"
        case "wav": return "audio/wav"
        case "ogg": return "audio/ogg"
        case "txt": return "text/plain; charset=utf-8"
        case "woff": return "font/woff"
        case "woff2": return "font/woff2"
        case "ttf": return "font/ttf"
        case "wasm": return "application/wasm"
        default: return "application/octet-stream"
        }
    }
}
