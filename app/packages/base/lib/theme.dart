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
/// 主色是蓝色系；状态这类「一眼要分清」的地方用糖果色——粉、橙、薄荷、青。
/// 糖果色在浅色底上太浅（对比度到不了 4.5），所以浅色模式取同一个色相的
/// 深一档，深色模式取亮一档：色相不变，亮度各走各的。
abstract final class AppColors {
  /// 主题色：蓝。浅色模式用够深的一档（正文对比度 ≥ 4.5）。
  static const brand = Color(0xFF2563EB);

  /// 深色模式的蓝：同一个色相提亮，放在深底上才够亮。
  static const brandDark = Color(0xFF8FB4FF);

  /// 糖果色板：只做点缀（徽章圆点、图标、选中态），不拿去做大面积底色。
  static const candySky = Color(0xFF38BDF8);
  static const candyMint = Color(0xFF34D399);
  static const candyLemon = Color(0xFFFFD166);
  static const candyPeach = Color(0xFFFFA45B);
  static const candyPink = Color(0xFFFF7EB0);
  static const candyLilac = Color(0xFFA78BFA);

  /// 头像底色就从这里挑：同一个名字永远同一个色，换设备也不变。
  static const candies = [candySky, candyMint, candyLemon, candyPeach, candyPink, candyLilac];

  static Color _pick(BuildContext context, Color light, Color dark) =>
      Theme.of(context).brightness == Brightness.dark ? dark : light;

  /// 等你确认（糖果橙）。
  static Color waiting(BuildContext context) =>
      _pick(context, const Color(0xFFC2410C), const Color(0xFFFFB870));

  /// 进行中（糖果青）。
  static Color running(BuildContext context) =>
      _pick(context, const Color(0xFF0E7490), const Color(0xFF6FE0F0));

  /// 卡住、打回（糖果粉）。
  static Color blocked(BuildContext context) =>
      _pick(context, const Color(0xFFC2185B), const Color(0xFFFF9BBF));

  /// 已完成（糖果薄荷）。
  static Color done(BuildContext context) =>
      _pick(context, const Color(0xFF15803D), const Color(0xFF7DE9A8));

  /// 空闲、停用（偏蓝的冷灰，别跟品牌蓝抢注意力）。
  static Color idle(BuildContext context) =>
      _pick(context, const Color(0xFF5B6472), const Color(0xFFAEB6C4));

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

/// 蓝色主题的完整色板。
///
/// `fromSeed` 只负责生成「没显式给的」那些角色（比如 onSurface 的中性色），
/// 主色、容器色、背景色都自己给：种子色算出来的蓝偏灰，做出来的界面
/// 看着不像「蓝色系」，也不够糖果。
ColorScheme _blueScheme(Brightness brightness) {
  final base = ColorScheme.fromSeed(seedColor: AppColors.brand, brightness: brightness);
  if (brightness == Brightness.dark) {
    return base.copyWith(
      primary: AppColors.brandDark,
      onPrimary: const Color(0xFF0A1B3D),
      primaryContainer: const Color(0xFF1E3B7A),
      onPrimaryContainer: const Color(0xFFDCE7FF),
      secondary: const Color(0xFF9DBBFF),
      onSecondary: const Color(0xFF0A1B3D),
      secondaryContainer: const Color(0xFF22335C),
      onSecondaryContainer: const Color(0xFFDCE7FF),
      tertiary: AppColors.candyLilac,
      onTertiary: const Color(0xFF23124F),
      tertiaryContainer: const Color(0xFF3B2B6E),
      onTertiaryContainer: const Color(0xFFEDE7FF),
      error: const Color(0xFFFF9BBF),
      onError: const Color(0xFF4A0F24),
      errorContainer: const Color(0xFF6B1436),
      onErrorContainer: const Color(0xFFFFE1EA),
      surface: const Color(0xFF0F1420),
      onSurface: const Color(0xFFE6EAF4),
      onSurfaceVariant: const Color(0xFFB2BCD2),
      surfaceContainerLowest: const Color(0xFF0B0F19),
      surfaceContainerLow: const Color(0xFF151B29),
      surfaceContainer: const Color(0xFF1A2132),
      surfaceContainerHigh: const Color(0xFF202839),
      surfaceContainerHighest: const Color(0xFF263044),
      outline: const Color(0xFF6B7690),
      outlineVariant: const Color(0xFF333D52),
    );
  }
  return base.copyWith(
    primary: AppColors.brand,
    onPrimary: const Color(0xFFFFFFFF),
    primaryContainer: const Color(0xFFDCE7FF),
    onPrimaryContainer: const Color(0xFF0B2A66),
    secondary: const Color(0xFF2F6FED),
    onSecondary: const Color(0xFFFFFFFF),
    secondaryContainer: const Color(0xFFE3ECFF),
    onSecondaryContainer: const Color(0xFF0A2A6B),
    tertiary: const Color(0xFF7C5CFF),
    onTertiary: const Color(0xFFFFFFFF),
    tertiaryContainer: const Color(0xFFEDE7FF),
    onTertiaryContainer: const Color(0xFF2A1170),
    // 错误色用糖果粉偏红：和「卡住」的粉是同一族，但不至于撞色
    error: const Color(0xFFD92D5C),
    onError: const Color(0xFFFFFFFF),
    errorContainer: const Color(0xFFFFE1EA),
    onErrorContainer: const Color(0xFF5C0A24),
    surface: const Color(0xFFF7F9FF),
    surfaceContainerLowest: const Color(0xFFFFFFFF),
    surfaceContainerLow: const Color(0xFFEAF0FD),
    surfaceContainer: const Color(0xFFE2EAFB),
    surfaceContainerHigh: const Color(0xFFDAE4F8),
    surfaceContainerHighest: const Color(0xFFD2DEF5),
    outline: const Color(0xFF8E9AB3),
    outlineVariant: const Color(0xFFD5DEEC),
  );
}

ThemeData buildTheme(Brightness brightness) {
  final dark = brightness == Brightness.dark;
  final scheme = _blueScheme(brightness);

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
      // hint 调得比正文淡一截：默认色和已输入文字几乎一样深，
      // 一眼分不清「框里是占位提示还是用户已经打了字」。
      hintStyle: textTheme.bodyMedium!.copyWith(
        color: scheme.onSurfaceVariant.withValues(alpha: 0.55),
      ),
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
    // 不用 SnackBar：提示统一走原生 toast（NativeToast.show）。
    // 这里保留造型主题只是为了万一某个系统对话框内部用到时不难看。
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
