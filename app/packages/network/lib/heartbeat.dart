import 'dart:async';

/// 心跳：定时问一次「后端还在老地方吗」。
///
/// 单独抽出来是因为换址策略可能变（比如以后加 WebSocket 推送、
/// 改自适应间隔），而调用方只关心 start/stop。
class NetworkHeartbeat {
  NetworkHeartbeat({required this.onBeat, this.interval = const Duration(seconds: 60)});

  final Future<void> Function() onBeat;
  final Duration interval;

  Timer? _timer;
  Future<void> _inFlight = Future.value();

  /// 门控：返回 false 时这一拍直接跳过（比如未登录——没有 token，
  /// 换址也验不了身份）。
  bool Function()? canBeat;

  bool get running => _timer != null;

  void start() {
    if (_timer != null) return;
    _timer = Timer.periodic(interval, (_) => _beatGuarded());
  }

  void stop() {
    _timer?.cancel();
    _timer = null;
  }

  /// 上一拍还没回来就不开新的：resolve 一轮最多要摸 3 个候选地址
  /// （每个 5s 探活），慢网下完全可能超过 60s，不排队就会叠出
  /// 一串并发请求。
  Future<void> _beatGuarded() {
    if (canBeat?.call() == false) return _inFlight;
    _inFlight = _inFlight.then((_) => onBeat());
    return _inFlight;
  }

  /// 测试用：手动触发一拍（不用等 60s 定时器），返回这拍真正落地的 Future。
  Future<void> beat() => _beatGuarded();
}
