import UIKit
import WebKit

/// Один экран: WKWebView с игрой, которую отдаёт встроенный сервер.
final class GameViewController: UIViewController, WKNavigationDelegate {
    static let background = UIColor(red: 0.102, green: 0.078, blue: 0.063, alpha: 1) // #1a1410
    private static let port: UInt16 = 8765

    private var webView: WKWebView!
    private var server: LocalServer?
    private let spinner = UIActivityIndicatorView(style: .large)
    private let errorLabel = UILabel()

    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .landscape }
    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Self.background

        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        webView = WKWebView(frame: .zero, configuration: config)
        webView.translatesAutoresizingMaskIntoConstraints = false
        webView.isOpaque = false
        webView.backgroundColor = Self.background
        webView.scrollView.backgroundColor = Self.background
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.allowsLinkPreview = false
        webView.navigationDelegate = self
        #if DEBUG
        if #available(iOS 16.4, *) { webView.isInspectable = true }   // Safari → Develop
        #endif
        view.addSubview(webView)

        let guide = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: guide.topAnchor),
            webView.bottomAnchor.constraint(equalTo: guide.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: guide.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: guide.trailingAnchor),
        ])

        spinner.color = UIColor(red: 0.95, green: 0.76, blue: 0.31, alpha: 1)
        spinner.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(spinner)
        NSLayoutConstraint.activate([
            spinner.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: view.centerYAnchor),
        ])
        spinner.startAnimating()

        errorLabel.textColor = .white
        errorLabel.numberOfLines = 0
        errorLabel.textAlignment = .center
        errorLabel.isHidden = true
        errorLabel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(errorLabel)
        NSLayoutConstraint.activate([
            errorLabel.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            errorLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
            errorLabel.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
        ])

        NotificationCenter.default.addObserver(
            self, selector: #selector(setAudio(paused:)), name: UIApplication.willResignActiveNotification, object: nil)
        NotificationCenter.default.addObserver(
            self, selector: #selector(resumeAudio), name: UIApplication.didBecomeActiveNotification, object: nil)

        startGame()
    }

    private func fail(_ text: String) {
        spinner.stopAnimating()
        errorLabel.text = text
        errorLabel.isHidden = false
    }

    private func startGame() {
        guard let www = Bundle.main.url(forResource: "www", withExtension: nil),
              FileManager.default.fileExists(atPath: www.appendingPathComponent("index.html").path)
        else {
            return fail("В приложении нет игры (папка www).\nЗапустите tool/sync_web.sh и соберите заново.")
        }
        let server = LocalServer(root: www)
        self.server = server
        server.start(port: Self.port) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success:
                self.webView.load(URLRequest(url: URL(string: "http://127.0.0.1:\(Self.port)/index.html")!))
            case .failure(let error):
                self.fail("Не удалось запустить игру: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { spinner.stopAnimating() }

    func webView(
        _ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        // Внутри остаётся только своя игра; чужие переходы блокируем.
        let host = action.request.url?.host ?? ""
        let scheme = action.request.url?.scheme ?? ""
        decisionHandler(host == "127.0.0.1" || scheme == "about" || scheme == "blob" ? .allow : .cancel)
    }

    // MARK: - Музыка при сворачивании

    @objc private func setAudio(paused: Bool = true) {
        webView?.evaluateJavaScript(
            "document.querySelectorAll('audio').forEach(function(m){if(!m.paused){m.dataset.kcPaused='1';m.pause();}});")
    }

    @objc private func resumeAudio() {
        webView?.evaluateJavaScript(
            "document.querySelectorAll('audio').forEach(function(m){if(m.dataset.kcPaused){delete m.dataset.kcPaused;m.play().catch(function(){});}});")
    }
}
