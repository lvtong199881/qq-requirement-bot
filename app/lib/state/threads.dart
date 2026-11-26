import 'dart:async';

import 'package:flutter/foundation.dart';

import 'package:network/network.dart';

import 'package:login/login.dart';

/// 需求列表的状态与轮询。
///
/// 为什么用轮询而不是 WebSocket：后端这一版就是普通 HTTP，而且
/// 用户明确说了「打开 App 才看，不需要推送」。3 秒一次的 GET 在
/// 团队内部规模下开销可以忽略，还省掉了长连接的重连/心跳/断线补拉
/// 一整套逻辑——那才是真正容易出错的地方。
class ThreadListController extends ChangeNotifier {
  ThreadListController({required this.auth, this.pollInterval = const Duration(seconds: 5)});

  final AuthController auth;
  final Duration pollInterval;

  List<Thread> threads = const [];
  bool loading = false;
  bool firstLoad = true;
  String? error;

  /// 上次拉取成功的时刻，界面可以显示「几秒前更新」。
  DateTime? lastSyncedAt;

  /// 需求引擎连没连上。null = 这台服务器没有独立的引擎（单机部署）。
  ///
  /// 单独存一份而不是塞进 Thread：引擎掉线是全站状态，跟哪个群无关。
  bool? engineOnline;

  /// agent 的显示名，服务端给。界面拼「@名字」用它，不写死。
  String botName = 'AI员工';

  Timer? _timer;
  bool _inFlight = false;
  bool _disposed = false;

  ApiClient get _api => auth.client;

  void start() {
    if (_timer != null) return;
    unawaited(refresh());
    _timer = Timer.periodic(pollInterval, (_) => unawaited(refresh(silent: true)));
  }

  void stop() {
    _timer?.cancel();
    _timer = null;
  }

  /// 拉列表。
  ///
  /// silent=true 时不动 loading、不清 error：轮询失败不该让已经在看的
  /// 列表闪成错误页，尤其手机上切个后台再回来很常见。
  Future<void> refresh({bool silent = false}) async {
    if (_disposed || _inFlight) return;
    if (!auth.hasClient || auth.stage != AuthStage.ready) return;
    _inFlight = true;
    if (!silent) {
      loading = true;
      error = null;
      notifyListeners();
    }
    try {
      // 顺手查一下引擎在不在。查不到不影响列表本身：引擎离线时
      // 群照样能聊，只是 @ 了它没人接。走 runWithFailover：
      // 隧道换址后这里自愈——探测失败→静默换址→重试，列表不闪错误页。
      final results = await Future.wait<Object?>([
        auth.runWithFailover((c) => c.listThreads()),
        _api.engineOnline().catchError((_) => null),
      ]);
      final page = results[0] as ({List<Thread> threads, String? botName});
      if (_disposed) return;
      engineOnline = results[1] as bool?;
      // 服务端没配 bot 名字时留空，界面统一退回默认的「AI员工」
      if ((page.botName ?? '').trim().isNotEmpty) botName = page.botName!.trim();
      threads = sortThreads(page.threads);
      lastSyncedAt = DateTime.now();
      error = null;
    } on ApiException catch (e) {
      if (_disposed) return;
      if (e.isAuth) {
        await auth.logout();
        return;
      }
      if (!silent) error = e.message;
    } finally {
      _inFlight = false;
      if (!_disposed) {
        loading = false;
        firstLoad = false;
        notifyListeners();
      }
    }
  }

  /// 排序规则：等我拍板的永远在最前，然后按最近活动倒序。
  ///
  /// 不做「进行中 / 已完成」分组标签——需求数量在团队规模下不多，
  /// 分组反而把「现在该我动手的」埋进第二个 tab。用 needsMe 置顶 +
  /// 视觉分组（置顶区加标题）就够。
  static List<Thread> sortThreads(List<Thread> input) {
    final out = [...input];
    out.sort((a, b) {
      if (a.needsMe != b.needsMe) return a.needsMe ? -1 : 1;
      final at = a.lastActiveAt ?? 0;
      final bt = b.lastActiveAt ?? 0;
      if (at != bt) return bt.compareTo(at);
      return a.threadId.compareTo(b.threadId);
    });
    return out;
  }

  /// 建群。只建容器，不带需求——需求要在群里说第一句话才开始。
  Future<Thread> create(String name) async {
    final t = await _api.createGroup(name);
    // 先本地插进去，界面立刻有反馈，不用等下一次轮询。
    threads = sortThreads([t, ...threads.where((x) => x.threadId != t.threadId)]);
    notifyListeners();
    unawaited(refresh(silent: true));
    return t;
  }

  @override
  void dispose() {
    _disposed = true;
    stop();
    super.dispose();
  }
}
