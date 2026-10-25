import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';

/// Игра лежит внутри приложения (assets/www) и отдаётся встроенным
/// локальным сервером на http://localhost:8080. Так работают ES-модули,
/// Web Workers (ИИ) и звук, а интернет нужен только для онлайн-режима.
const int kPort = 8080;
const Color kBackground = Color(0xFF1A1410);

final InAppLocalhostServer _server = InAppLocalhostServer(
  port: kPort,
  documentRoot: 'assets/www',
);

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await SystemChrome.setPreferredOrientations(const [
    DeviceOrientation.landscapeLeft,
    DeviceOrientation.landscapeRight,
  ]);
  await SystemChrome.setEnabledSystemUIMode(SystemUiMode.immersiveSticky);
  await _server.start();
  runApp(const KnightsApp());
}

class KnightsApp extends StatelessWidget {
  const KnightsApp({super.key});

  @override
  Widget build(BuildContext context) {
    return const MaterialApp(
      debugShowCheckedModeBanner: false,
      title: 'Рыцари и Замки',
      home: GamePage(),
    );
  }
}

class GamePage extends StatefulWidget {
  const GamePage({super.key});

  @override
  State<GamePage> createState() => _GamePageState();
}

class _GamePageState extends State<GamePage> with WidgetsBindingObserver {
  InAppWebViewController? _web;
  bool _loaded = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  /// Свернули приложение — ставим музыку на паузу, вернулись — продолжаем
  /// только то, что сами остановили (чтобы не включить выключенный звук).
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final hidden = state != AppLifecycleState.resumed;
    _web?.evaluateJavascript(source: hidden
        ? 'document.querySelectorAll("audio").forEach(function(m){'
            'if(!m.paused){m.dataset.kcPaused="1";m.pause();}});'
        : 'document.querySelectorAll("audio").forEach(function(m){'
            'if(m.dataset.kcPaused){delete m.dataset.kcPaused;'
            'm.play().catch(function(){});}});');
  }

  @override
  Widget build(BuildContext context) {
    return const MaterialApp(
      debugShowCheckedModeBanner: false,
      title: 'Рыцари и Замки',
      home: GamePage(),
    );
  }
}

class GamePage extends StatefulWidget {
  const GamePage({super.key});

  @override
  State<GamePage> createState() => _GamePageState();
}

class _GamePageState extends State<GamePage> with WidgetsBindingObserver {
  InAppWebViewController? _web;
  bool _loaded = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  /// Свернули приложение — ставим музыку на паузу, вернулись — продолжаем.
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final hidden = state != AppLifecycleState.resumed;
    _web?.evaluateJavascript(source: '''
      document.querySelectorAll("audio,video").forEach(function (m) {
        try { ${hidden ? 'm.pause()' : 'if (m.dataset.kcWasPlaying) m.play()'}; } catch (e) {}
      });
    ''');
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: kBackground,
      body: SafeArea(
        child: Stack(
          children: [
            InAppWebView(
              initialUrlRequest:
                  URLRequest(url: WebUri('http://localhost:$kPort/index.html')),
              initialSettings: InAppWebViewSettings(
                transparentBackground: false,
                javaScriptEnabled: true,
                mediaPlaybackRequiresUserGesture: false,
                allowsInlineMediaPlayback: true,
                allowsLinkPreview: false,
                disallowOverScroll: true,
                supportZoom: false,
                isInspectable: false,
                useShouldOverrideUrlLoading: true,
              ),
              onWebViewCreated: (c) => _web = c,
              onLoadStop: (c, url) => setState(() => _loaded = true),
              // Внутри остаётся только своя игра; всё чужое блокируем.
              shouldOverrideUrlLoading: (c, action) async {
                final host = action.request.url?.host ?? '';
                final ok = host == 'localhost' || host == '127.0.0.1';
                return ok
                    ? NavigationActionPolicy.ALLOW
                    : NavigationActionPolicy.CANCEL;
              },
            ),
            if (!_loaded)
              const ColoredBox(
                color: kBackground,
                child: Center(
                  child: CircularProgressIndicator(color: Color(0xFFF2C14F)),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
