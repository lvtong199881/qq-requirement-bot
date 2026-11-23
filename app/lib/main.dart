import 'package:flutter/material.dart';

import 'api/endpoint_resolver.dart';
import 'state/auth.dart';
import 'state/threads.dart';
import 'ui/home_page.dart';
import 'ui/login_page.dart';
import 'ui/server_setup_page.dart';
import 'ui/theme.dart';

/// 隧道换址的发现通道：一个比隧道本身稳的静态 JSON（服务器换域名时
/// 会自动更新它）。App 里所有自动换址都从这里拿候选地址。
/// 放编译期常量：地址变了的补救手段不能再依赖会变的东西。
const _kDiscoveryUrl =
    'https://gitee.com/api/v5/repos/mohanshang1/qq-requirement-bot/contents/endpoint.json';

void main() {
  runApp(const QqbotApp());
}

class QqbotApp extends StatefulWidget {
  const QqbotApp({super.key});

  @override
  State<QqbotApp> createState() => _QqbotAppState();
}

class _QqbotAppState extends State<QqbotApp> {
  final _auth = AuthController(
    endpointResolver: EndpointResolver(discoveryUrl: _kDiscoveryUrl),
  );

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
      // 固定字号：这个 App 的排版（时间、徽章、进度格子）是照 100% 缩放调的，
      // 跟随系统字号放大后按钮文字会撑破卡片。可访问性靠对比度和语义标签补，
      // 不靠让布局崩掉。
      builder: (context, child) => MediaQuery.withNoTextScaling(child: child!),
      home: _home(),
    );
  }

  Widget _home() {
    if (!_booted || _auth.stage == AuthStage.booting) {
      return const _Splash();
    }
    switch (_auth.stage) {
      case AuthStage.needServer:
        return ServerSetupPage(auth: _auth);
      case AuthStage.needLogin:
        return LoginPage(auth: _auth);
      case AuthStage.ready:
        final c = _threads;
        if (c == null) {
          return const _Splash();
        }
        // key 不含 baseUrl：静默换址（隧道域名变了）不该重建首页——
        // 重建会把群列表的滚动位置、已加载状态全部丢掉，用户会看到闪屏。
        // 真正「换了服务器」（用户手动改地址）走的是 setServer → needLogin，
        // 必然先回登录页，HomePage 会随 stage 切换自然重建，不靠这个 key。
        return HomePage(
          key: ValueKey('home'),
          auth: _auth,
          controller: c,
        );
      case AuthStage.booting:
        return const _Splash();
    }
  }
}

/// 启动占位：先留白，超过 1 秒才出转圈。
/// 恢复会话通常几十毫秒，立刻闪一下 spinner 反而像卡了一下。
class _Splash extends StatefulWidget {
  const _Splash();

  @override
  State<_Splash> createState() => _SplashState();
}

class _SplashState extends State<_Splash> {
  bool _show = false;

  @override
  void initState() {
    super.initState();
    Future<void>.delayed(const Duration(milliseconds: 1000), () {
      if (mounted) setState(() => _show = true);
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: _show
            ? const SizedBox(
                width: 24,
                height: 24,
                child: CircularProgressIndicator(strokeWidth: 2.5),
              )
            : null,
      ),
    );
  }
}
