import 'package:flutter/material.dart';

import 'state/auth.dart';
import 'state/threads.dart';
import 'ui/home_page.dart';
import 'ui/login_page.dart';
import 'ui/server_setup_page.dart';
import 'ui/theme.dart';

void main() {
  runApp(const QqbotApp());
}

class QqbotApp extends StatefulWidget {
  const QqbotApp({super.key});

  @override
  State<QqbotApp> createState() => _QqbotAppState();
}

class _QqbotAppState extends State<QqbotApp> {
  final _auth = AuthController();

  /// 列表控制器要跟着登录状态走：登录后才建，退出就销毁。
  /// 常驻一个 controller 会让旧 token 的轮询继续跑。
  ThreadListController? _threads;
  bool _booted = false;

  @override
  void initState() {
    super.initState();
    _auth.addListener(_onAuthChanged);
    _auth.restore().whenComplete(() {
      if (mounted) setState(() => _booted = true);
    });
  }

  @override
  void dispose() {
    _auth.removeListener(_onAuthChanged);
    _threads?.dispose();
    _auth.dispose();
    super.dispose();
  }

  void _onAuthChanged() {
    if (_auth.stage == AuthStage.ready) {
      _threads ??= ThreadListController(auth: _auth);
    } else {
      _threads?.dispose();
      _threads = null;
    }
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: '群',
      debugShowCheckedModeBanner: false,
      theme: buildTheme(Brightness.light),
      darkTheme: buildTheme(Brightness.dark),
      home: _home(),
    );
  }

  Widget _home() {
    if (!_booted || _auth.stage == AuthStage.booting) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    switch (_auth.stage) {
      case AuthStage.needServer:
        return ServerSetupPage(auth: _auth);
      case AuthStage.needLogin:
        return LoginPage(auth: _auth);
      case AuthStage.ready:
        final c = _threads;
        if (c == null) {
          return const Scaffold(body: Center(child: CircularProgressIndicator()));
        }
        // key 用 baseUrl：换了服务器就是另一份数据，
        // 不复用旧页面的状态（尤其滚动位置和已加载的消息）。
        return HomePage(
          key: ValueKey('home-${_auth.baseUrl}'),
          auth: _auth,
          controller: c,
        );
      case AuthStage.booting:
        return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
  }
}
