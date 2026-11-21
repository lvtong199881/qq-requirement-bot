import 'dart:async';

import 'package:flutter/material.dart';

import '../theme.dart';

/// 轻提示。
///
/// 为什么不用 SnackBar：它挂在 Scaffold 底部，会盖住输入区、还会把
/// 主操作往上顶；同一个 Scaffold 里连弹两条会排队，用户看不到最新那条。
/// 这里用 Overlay 自己画一条，位置、时长、颜色都由我们定。
///
/// 调用方只关心「说一句话」，所以是顶层函数而不是一个组件：
///   showToast(context, '已复制群号');
///   showToast(context, '保存失败', error: true);
void showToast(BuildContext context, String message, {bool error = false}) {
  final overlay = Overlay.maybeOf(context, rootOverlay: true);
  if (overlay == null) return;

  late OverlayEntry entry;
  entry = OverlayEntry(
    builder: (_) => _ToastHost(
      message: message,
      error: error,
      onDismissed: () {
        if (entry.mounted) entry.remove();
      },
    ),
  );
  overlay.insert(entry);
}

/// 一条 toast 的生命周期：淡入 → 停留 → 淡出 → 通知宿主移除
class _ToastHost extends StatefulWidget {
  const _ToastHost({
    required this.message,
    required this.error,
    required this.onDismissed,
  });

  final String message;
  final bool error;
  final VoidCallback onDismissed;

  @override
  State<_ToastHost> createState() => _ToastHostState();
}

class _ToastHostState extends State<_ToastHost> with SingleTickerProviderStateMixin {
  static const _fadeIn = Duration(milliseconds: 200);
  static const _hold = Duration(milliseconds: 2200);
  static const _fadeOut = Duration(milliseconds: 200);

  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: _fadeIn,
    reverseDuration: _fadeOut,
  );
  Timer? _timer;
  bool _closing = false;

  @override
  void initState() {
    super.initState();
    _c.forward();
    _timer = Timer(_fadeIn + _hold, _close);
  }

  Future<void> _close() async {
    if (_closing) return;
    _closing = true;
    _timer?.cancel();
    if (mounted) await _c.reverse();
    widget.onDismissed();
  }

  @override
  void dispose() {
    _timer?.cancel();
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    // 错误用 errorContainer，普通提示用反色：反色在任何主题下都和背景反差够大，
    // 而且不会和页面里的主色块混在一起。
    final bg = widget.error ? scheme.errorContainer : scheme.inverseSurface;
    final fg = widget.error ? scheme.onErrorContainer : scheme.onInverseSurface;

    return Positioned(
      left: AppSpace.lg,
      right: AppSpace.lg,
      // 抬离底部一点：输入区上面，但不压住发送键
      bottom: MediaQuery.viewInsetsOf(context).bottom + 96,
      child: FadeTransition(
        opacity: _c,
        child: Material(
          color: Colors.transparent,
          child: GestureDetector(
            onTap: _close,
            child: Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 420),
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    color: bg,
                    borderRadius: BorderRadius.circular(AppRadius.medium),
                  ),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: AppSpace.md,
                      vertical: AppSpace.sm,
                    ),
                    child: Text(
                      widget.message,
                      style: AppText.bodyS.copyWith(color: fg),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
