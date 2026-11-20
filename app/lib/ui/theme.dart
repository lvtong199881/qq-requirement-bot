import 'package:flutter/material.dart';

/// 一套克制的配色。
///
/// 需求阶段的颜色是有语义的（等你确认=要动手，卡住=出事了），
/// 所以这些色值集中在这里，不要在页面里散落 Color(0x...)。
class AppColors {
  static const seed = Color(0xFF4A6FA5);

  /// 等你确认 —— 需要我拍板，最需要注意
  static const waiting = Color(0xFFE8833A);

  /// 进行中
  static const running = Color(0xFF3F7FD1);

  /// 卡住 / 失败
  static const blocked = Color(0xFFD1495B);

  /// 已完成
  static const done = Color(0xFF3F9B6B);

  /// 未开始
  static const idle = Color(0xFF8C8C8C);

  /// 按后端返回的中文状态取色。
  /// 未知状态给灰色而不是抛错——后端加新状态时 App 不该白屏。
  static Color forStageStatus(String? status) {
    switch (status) {
      case '等你确认':
      case '等待确认':
        return waiting;
      case '进行中':
        return running;
      case '卡住':
      case '阻塞':
        return blocked;
      case '已完成':
      case '已交付':
        return done;
      default:
        return idle;
    }
  }
}

ThemeData buildTheme(Brightness brightness) {
  final scheme = ColorScheme.fromSeed(
    seedColor: AppColors.seed,
    brightness: brightness,
  );
  return ThemeData(
    colorScheme: scheme,
    useMaterial3: true,
    // 聊天气泡和阶段卡都靠留白分隔，不要到处画分割线
    scaffoldBackgroundColor: scheme.surface,
    appBarTheme: AppBarTheme(
      backgroundColor: scheme.surface,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      scrolledUnderElevation: 0.5,
      centerTitle: false,
    ),
    cardTheme: CardThemeData(
      elevation: 0,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: scheme.surfaceContainerHighest.withValues(alpha: 0.5),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: BorderSide.none,
      ),
      contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        minimumSize: const Size(0, 46),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      ),
    ),
    snackBarTheme: const SnackBarThemeData(behavior: SnackBarBehavior.floating),
  );
}
