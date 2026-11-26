import 'package:flutter/material.dart';

import 'theme.dart';

/// 错误提示条。
///
/// 登录页、连接页都在用同一套「红底 + 图标 + 一句话」，抽出来是为了
/// 别让两处的圆角、内边距各写一个值——那种不一致用户一眼就能看出「这不是
/// 同一个 App」。
class ErrorBox extends StatelessWidget {
  const ErrorBox({super.key, required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.all(AppSpace.sm),
      decoration: BoxDecoration(
        color: scheme.errorContainer,
        borderRadius: BorderRadius.circular(AppRadius.medium),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.error_outline, size: 20, color: scheme.onErrorContainer),
          const SizedBox(width: AppSpace.xs),
          Expanded(
            child: Text(
              message,
              style: AppText.bodyS.copyWith(color: scheme.onErrorContainer),
            ),
          ),
        ],
      ),
    );
  }
}

/// 一行带图标的说明文字（「为什么是这样」这类补充信息）。
class HintRow extends StatelessWidget {
  const HintRow({super.key, required this.text, this.icon = Icons.info_outline});

  final String text;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, size: 20, color: scheme.onSurfaceVariant),
        const SizedBox(width: AppSpace.xs),
        Expanded(
          child: Text(
            text,
            style: AppText.bodyS.copyWith(color: scheme.onSurfaceVariant),
          ),
        ),
      ],
    );
  }
}
