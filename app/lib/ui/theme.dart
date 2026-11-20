import 'package:flutter/material.dart';

/// 设计 token。数值全部来自 `docs/MOBILE-UI.md`：
///
/// - 间距只用 4 的倍数（4/8/12/16/20/24/32/40/48）；
/// - 圆角只有 8（输入框、小标签）/ 12（卡片、按钮）/ 16（弹层）+ 胶囊；
/// - 字号只有六级阶梯（13 以下只给时间、计数这类次要信息）。
///
/// 页面里不要再写裸数字——规范要调的时候只改这一个文件，
/// 否则同一种「卡片间距」会在六个页面里各写成 10、11、14 三种样子。
abstract final class AppSpace {
  static const double xxs = 4;
  static const double xs = 8;
  static const double sm = 12;
  static const double md = 16;
  static const double lg = 20;
  static const double xl = 24;
  static const double xxl = 32;
  static const double huge = 40;
}

/// 页面边距：内容页左右 16，表单页 20（规范里表单单独放宽一档）。
abstract final class AppInset {
  static const double page = 16;
  static const double form = 20;
}

abstract final class AppRadius {
  /// 输入框、小标签。
  static const double small = 8;

  /// 卡片、按钮。
  static const double medium = 12;

  /// 弹层（对话框、底部抽屉）。
  static const double large = 16;

  /// 胶囊（徽章、头像式标签）。
  static const double pill = 999;
}

/// 字号阶梯。
///
/// 颜色一律不在这里定，用的时候从 `Theme.of(context).colorScheme` 取，
/// 否则深色模式得给每一处再写一遍。
abstract final class AppText {
  static const TextStyle display = TextStyle(fontSize: 32, height: 1.25, fontWeight: FontWeight.w700);
  static const TextStyle titleL = TextStyle(fontSize: 24, height: 1.3, fontWeight: FontWeight.w600);
  static const TextStyle titleM = TextStyle(fontSize: 20, height: 1.3, fontWeight: FontWeight.w600);
  static const TextStyle titleS = TextStyle(fontSize: 17, height: 1.35, fontWeight: FontWeight.w600);
  static const TextStyle body = TextStyle(fontSize: 16, height: 1.5, fontWeight: FontWeight.w400);
  static const TextStyle bodyS = TextStyle(fontSize: 14, height: 1.45, fontWeight: FontWeight.w400);

  /// 只有一个词的标签（区块标题、按钮文字）。
  static const TextStyle label = TextStyle(fontSize: 13, height: 1.35, fontWeight: FontWeight.w600);

  /// 时间、计数、单位——规范允许唯一低于 13 的地方。
  static const TextStyle caption = TextStyle(fontSize: 11, height: 1.3, fontWeight: FontWeight.w400);
}

/// 语义色：状态、失败、成功。
///
/// 深浅色分开取值——同一个橙色放在白底上要够暗（对比度 ≥ 4.5），
/// 放在深色底上要够亮，一个常量满足不了两边。
abstract final class AppColors {
  static const brand = Color(0xFF4A6FA5);

  static Color _pick(BuildContext context, Color light, Color dark) =>
      Theme.of(context).brightness == Brightness.dark ? dark : light;

  /// 等你确认（橙）。
  static Color waiting(BuildContext context) =>
      _pick(context, const Color(0xFF8A5200), const Color(0xFFF0B574));

  /// 进行中（蓝）。
  static Color running(BuildContext context) =>
      _pick(context, const Color(0xFF1B5AA8), const Color(0xFF92BDF7));

  /// 卡住、打回（红）。
  static Color blocked(BuildContext context) =>
      _pick(context, const Color(0xFFA82A22), const Color(0xFFF3A39C));

  /// 已完成（绿）。
  static Color done(BuildContext context) =>
      _pick(context, const Color(0xFF1C6A45), const Color(0xFF8CD6AE));

  /// 空闲、停用（灰）。
  static Color idle(BuildContext context) =>
      _pick(context, const Color(0xFF5A6068), const Color(0xFFA8AEB6));

  /// 阶段状态 → 颜色。
  static Color stage(BuildContext context, String? status) {
    final s = status?.trim() ?? '';
    if (s.isEmpty) return idle(context);
    if (s.contains('等你确认') || s.contains('等待确认')) return waiting(context);
    if (s.contains('进行中')) return running(context);
    if (s.contains('卡住') || s.contains('阻塞') || s.contains('打回')) return blocked(context);
    if (s.contains('已完成') || s.contains('已交付')) return done(context);
    return idle(context);
  }
}

ThemeData buildTheme(Brightness brightness) {
  final dark = brightness == Brightness.dark;
  final scheme = ColorScheme.fromSeed(seedColor: AppColors.brand, brightness: brightness);

  final textTheme = TextTheme(
    displayLarge: AppText.display,
    headlineLarge: AppText.titleL,
    headlineMedium: AppText.titleM,
    headlineSmall: AppText.titleM,
    titleLarge: AppText.titleM,
    titleMedium: AppText.titleS,
    titleSmall: AppText.body.copyWith(fontWeight: FontWeight.w600),
    bodyLarge: AppText.body,
    bodyMedium: AppText.body,
    bodySmall: AppText.bodyS,
    labelLarge: AppText.label,
    labelMedium: AppText.label,
    labelSmall: AppText.caption.copyWith(fontWeight: FontWeight.w500),
  ).apply(
    bodyColor: scheme.onSurface,
    displayColor: scheme.onSurface,
  );

  OutlineInputBorder border(Color color, double width) => OutlineInputBorder(
    borderRadius: BorderRadius.circular(AppRadius.small),
    borderSide: BorderSide(color: color, width: width),
  );

  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    brightness: brightness,
    textTheme: textTheme,
    scaffoldBackgroundColor: scheme.surface,
    appBarTheme: AppBarTheme(
      backgroundColor: scheme.surface,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      scrolledUnderElevation: 0,
      centerTitle: false,
      titleTextStyle: textTheme.titleMedium!.copyWith(color: scheme.onSurface),
      iconTheme: IconThemeData(color: scheme.onSurface, size: 24),
    ),
    cardTheme: CardThemeData(
      elevation: 0,
      margin: EdgeInsets.zero,
      color: dark ? scheme.surfaceContainerHigh : scheme.surfaceContainerLow,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppRadius.medium)),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: dark ? scheme.surfaceContainerHigh : scheme.surfaceContainerLowest,
      isDense: true,
      contentPadding: const EdgeInsets.symmetric(horizontal: AppSpace.md, vertical: AppSpace.sm),
      border: border(scheme.outlineVariant, 1),
      enabledBorder: border(scheme.outlineVariant, 1),
      focusedBorder: border(scheme.primary, 2),
      errorBorder: border(scheme.error, 1),
      focusedErrorBorder: border(scheme.error, 2),
      labelStyle: textTheme.bodyMedium!.copyWith(color: scheme.onSurfaceVariant),
      floatingLabelStyle: textTheme.bodySmall!.copyWith(color: scheme.primary),
      hintStyle: textTheme.bodyMedium!.copyWith(color: scheme.onSurfaceVariant),
      helperStyle: textTheme.labelSmall!.copyWith(color: scheme.onSurfaceVariant),
      helperMaxLines: 2,
      errorStyle: textTheme.labelSmall!.copyWith(color: scheme.error),
      errorMaxLines: 2,
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        padding: const EdgeInsets.symmetric(horizontal: AppSpace.xl, vertical: AppSpace.sm),
        minimumSize: Size.zero,
        textStyle: AppText.body.copyWith(fontWeight: FontWeight.w600),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppRadius.medium)),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        padding: const EdgeInsets.symmetric(horizontal: AppSpace.xl, vertical: AppSpace.sm),
        minimumSize: Size.zero,
        textStyle: AppText.body.copyWith(fontWeight: FontWeight.w600),
        side: BorderSide(color: scheme.outlineVariant),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppRadius.medium)),
      ),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(
        padding: const EdgeInsets.symmetric(horizontal: AppSpace.sm, vertical: AppSpace.xs),
        minimumSize: Size.zero,
        textStyle: AppText.body.copyWith(fontWeight: FontWeight.w600),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppRadius.small)),
      ),
    ),
    iconButtonTheme: IconButtonThemeData(
      style: IconButton.styleFrom(padding: const EdgeInsets.all(10)),
    ),
    dialogTheme: DialogThemeData(
      backgroundColor: scheme.surfaceContainerHigh,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppRadius.large)),
      titleTextStyle: textTheme.titleMedium!.copyWith(color: scheme.onSurface),
      contentTextStyle: AppText.body.copyWith(color: scheme.onSurfaceVariant),
    ),
    snackBarTheme: SnackBarThemeData(
      behavior: SnackBarBehavior.floating,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppRadius.medium)),
      contentTextStyle: AppText.bodyS.copyWith(color: scheme.onInverseSurface),
    ),
    dividerTheme: DividerThemeData(
      thickness: 1,
      space: 1,
      color: scheme.onSurface.withValues(alpha: 0.08),
    ),
    listTileTheme: const ListTileThemeData(
      contentPadding: EdgeInsets.symmetric(horizontal: AppSpace.md),
      minVerticalPadding: AppSpace.sm,
    ),
    progressIndicatorTheme: ProgressIndicatorThemeData(
      color: scheme.primary,
      circularTrackColor: Colors.transparent,
    ),
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: scheme.surface,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      indicatorColor: scheme.primaryContainer,
      labelTextStyle: WidgetStatePropertyAll(textTheme.labelSmall),
    ),
  );
}
