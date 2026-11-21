import 'package:flutter/material.dart';

import '../theme.dart';

/// 首字头像：群、成员暂时都还没有上传头像，先用名字首字顶上。
///
/// 颜色从名字算：同一个群/同一个人在列表页、设置页、成员区显示的是同一个色，
/// 靠肉眼也能认出「这两处说的是同一个东西」。用糖果色板提亮，配深一档的文字色
/// 保证浅底上的对比度——纯白字压在柠檬黄上根本看不清。
class InitialAvatar extends StatelessWidget {
  const InitialAvatar({
    super.key,
    required this.name,
    this.size = 40,
    this.isBot = false,
  });

  /// 取首字的名字。空名字落成「?」，不要画一个没有内容的圆。
  final String name;

  /// 直径。由调用方按场景给（列表 40、设置页 56、成员 40）
  final double size;

  /// 机器人成员在角上点一个小标记，和真人区分开
  final bool isBot;

  /// 首字：中文取第一个字，英文取大写首字母
  static String initialOf(String name) {
    final trimmed = name.trim();
    if (trimmed.isEmpty) return '?';
    return trimmed.characters.first.toUpperCase();
  }

  /// 同一个名字对应同一个糖果色
  static Color tintOf(String name) {
    if (name.trim().isEmpty) return AppColors.candySky;
    final i = name.trim().hashCode.abs() % AppColors.candies.length;
    return AppColors.candies[i];
  }

  @override
  Widget build(BuildContext context) {
    final tint = tintOf(name);
    // 糖果色当底要用很薄的透明度，字用同色相压深的一档：
    // 浅色底上糖果原色当文字对比度不够，压深之后既能认出颜色又读得清。
    final dark = Theme.of(context).brightness == Brightness.dark;
    final fg = dark ? Color.lerp(tint, Colors.white, 0.55)! : Color.lerp(tint, Colors.black, 0.5)!;

    return SizedBox(
      width: size,
      height: size,
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          Container(
            width: size,
            height: size,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: tint.withValues(alpha: dark ? 0.22 : 0.18),
              shape: BoxShape.circle,
            ),
            child: Text(
              initialOf(name),
              style: TextStyle(
                fontSize: size * 0.42,
                fontWeight: FontWeight.w600,
                color: fg,
                height: 1.1,
              ),
            ),
          ),
          if (isBot)
            Positioned(
              right: 0,
              bottom: 0,
              child: Container(
                padding: const EdgeInsets.all(2),
                decoration: BoxDecoration(
                  color: Theme.of(context).colorScheme.surface,
                  shape: BoxShape.circle,
                ),
                child: Icon(
                  Icons.smart_toy_outlined,
                  size: size * 0.26,
                  color: Theme.of(context).colorScheme.primary,
                ),
              ),
            ),
        ],
      ),
    );
  }
}
