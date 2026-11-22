import 'dart:async';

import 'package:flutter/foundation.dart';

import '../api/client.dart';
import '../api/models.dart';
import 'auth.dart';

/// 需求详情的状态：阶段进度 + 消息流 + 发送/通过/打回。
///
/// 轮询策略和列表页不同：这里只拉 since=lastSeq 的增量。
/// 长会话（一个需求几十轮）整页重拉会让列表滚动位置跟着抖，
/// 而且白费流量。增量拉还有个好处：新消息可以只对新增的那几条做
/// 出现动画，读起来像聊天。
class ThreadDetailController extends ChangeNotifier {
  ThreadDetailController({
    required this.auth,
    required this.threadId,
    Thread? seed,
    this.pollInterval = const Duration(seconds: 3),
  }) : thread = seed;

  final AuthController auth;
  final String threadId;
  final Duration pollInterval;

  /// 列表页传过来的那条，进来立刻有东西可画，不用先转圈。
  Thread? thread;
  List<Message> messages = const [];

  bool loading = true;
  bool sending = false;
  String? error;

  /// 操作失败（通过/打回/发送）的提示，界面用 toast 显示后清掉。
  String? actionError;

  int _lastSeq = 0;

  /// 已经上报过的已读位置，避免每次轮询都重复写一遍。
  int _reportedRead = 0;
  Timer? _timer;
  bool _inFlight = false;
  bool _disposed = false;

  ApiClient get _api => auth.client;

  /// 能不能点通过/打回。以服务端为准（thread.canAct 来自 /api/threads 的
  /// 群级判定：系统管理员，或这个群的群主/群管理员），不在前端按 role 硬编码。
  bool get canAct => thread?.canAct == true;

  /// 现在该不该显示通过/打回按钮：在等你确认、或者有阻塞时才有意义。
  /// 其它阶段点通过会被编排层当成闲聊，按钮留着只会误导。
  bool get showActions => canAct && (thread?.needsMe == true || thread?.blocked == true);

  void start() {
    if (_timer != null) return;
    unawaited(_load(initial: true));
    _timer = Timer.periodic(pollInterval, (_) => unawaited(_load()));
  }

  void stop() {
    _timer?.cancel();
    _timer = null;
  }

  /// 立刻刷一次（发完消息、点完通过后调）。
  Future<void> refreshNow() => _load();

  Future<void> _load({bool initial = false}) async {
    if (_disposed || _inFlight) return;
    if (!auth.hasClient || auth.stage != AuthStage.ready) return;
    _inFlight = true;
    if (initial) {
      loading = true;
      error = null;
      notifyListeners();
    }
    try {
      // 详情和消息一起拉：只要一个的话，要么阶段条不动，要么消息不动。
      final results = await Future.wait([
        _api.thread(threadId),
        _api.messages(threadId, since: _lastSeq),
      ]);
      if (_disposed) return;
      thread = results[0] as Thread;

      final page = results[1] as ({List<Message> messages, int lastSeq});
      if (page.messages.isNotEmpty) {
        // 按 seq 去重：服务端给的 lastSeq 只要比它返回的最新一条小一点
        // （缓存没跟上、磁盘被外部改过），下一轮就会把同一批消息再发一遍，
        // 聊天记录里就会并排出现两条一模一样的。
        final seen = messages.map((m) => m.seq).toSet();
        final fresh = page.messages.where((m) => seen.add(m.seq)).toList();
        if (fresh.isNotEmpty) messages = [...messages, ...fresh];
      }
      // 用服务端给的值，不要自己 +1 猜：中间可能有别的客户端发的消息。
      // 只进不退：拉回的 lastSeq 若比手里的小，按小的走会一直重复拉同一段。
      if (page.lastSeq > _lastSeq) _lastSeq = page.lastSeq;
      _markRead();
      error = null;
    } on ApiException catch (e) {
      if (_disposed) return;
      // 401 才是登录态没了；403 可能是「没加入这个群」，
      // 那种情况要在页面上给加入入口，不能把人踢回登录页。
      if (e.isUnauthenticated) {
        await auth.logout();
        return;
      }
      // 只有首次加载失败才占满屏；轮询失败静默，等下个周期自己好。
      if (initial) error = e.message;
    } finally {
      _inFlight = false;
      if (!_disposed) {
        loading = false;
        notifyListeners();
      }
    }
  }

  /// 上报已读位置，让列表页的红点消掉。
  ///
  /// 只在位置真的往前走了才发：详情页每 3 秒轮询一次，每次都上报等于
  /// 在轮询里再塞一次写请求。失败也不重试——下次轮询自然会补上。
  void _markRead() {
    if (_lastSeq <= _reportedRead) return;
    _reportedRead = _lastSeq;
    unawaited(_api.markRead(threadId, _lastSeq));
  }

  Future<bool> send(
    String text, {
    List<String> mentions = const [],
    List<MessageAnswer> answers = const [],
    int? askSeq,
  }) async {
    final trimmed = text.trim();
    // 点卡片提交时文本是自动拼的，但用户也可能什么都没勾——那种情况由页面拦住，
    // 这里只要求「有文本或有勾选」。
    if (trimmed.isEmpty && answers.isEmpty) return false;
    sending = true;
    actionError = null;
    notifyListeners();
    try {
      await _api.sendMessage(
        threadId,
        trimmed,
        mentions: mentions,
        answers: answers,
        askSeq: askSeq,
      );
      // 后端是先落库再返回的，所以紧跟着的这次拉取一定包含刚发的那条。
      // 不做本地乐观插入：那要做文本去重，一旦后端改措辞就会重影。
      _inFlight = false;
      await _load();
      return true;
    } on ApiException catch (e) {
      actionError = e.message;
      return false;
    } finally {
      sending = false;
      if (!_disposed) notifyListeners();
    }
  }

  Future<bool> approve() => _decide(() => _api.approve(threadId));

  Future<bool> reject(String reason) => _decide(() => _api.reject(threadId, reason));

  Future<bool> _decide(Future<void> Function() run) async {
    sending = true;
    actionError = null;
    notifyListeners();
    try {
      await run();
      _inFlight = false;
      await _load();
      return true;
    } on ApiException catch (e) {
      // 权限不足是这里最常见的失败（普通成员能看到按钮）。
      // 后端已经把「只有系统管理员能操作」写好了，直接透传，
      // 不要自己再拼一句「操作失败」把有用信息盖掉。
      actionError = e.message;
      return false;
    } finally {
      sending = false;
      if (!_disposed) notifyListeners();
    }
  }

  void clearActionError() {
    if (actionError == null) return;
    actionError = null;
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    stop();
    super.dispose();
  }
}
