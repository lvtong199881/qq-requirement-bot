import 'package:flutter/material.dart';

import 'package:base/base.dart';
import 'package:network/network.dart';

/// 需求卡片：群消息里「这一单要做什么、打到哪个 APP」的固定格式。
///
/// 单独写一个而不复用 AskCardView：那是「等你拍板」的交互卡（有勾选项、有提交
/// 按钮、提交后变「已回答」），而这里只是给已发生的事留个说明，不可交互。
/// 两者的状态机完全不同，硬套会让 AskCardView 里多出一堆「这张卡不可提交」的
/// 分支判断。
class RequirementCardView extends StatelessWidget {
  const RequirementCardView({super.key, required this.card});

  final RequirementCard card;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final title = card.name.trim().isEmpty ? '新需求' : card.name.trim();
    final repo = (card.repoName ?? '').trim();

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(AppSpace.md),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerLow,
        borderRadius: BorderRadius.circular(AppRadius.medium),
        border: Border.all(color: scheme.outlineVariant),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.assignment_outlined, size: 18, color: scheme.primary),
              const SizedBox(width: AppSpace.xs),
              Expanded(
                child: Text(
                  title,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: AppText.titleS.copyWith(color: scheme.onSurface),
                ),
              ),
            ],
          ),
          if (card.text.trim().isNotEmpty) ...[
            const SizedBox(height: AppSpace.sm),
            // 长按可复制：需求正文常有路径、字段名，摘一段发出去是常态
            SelectionArea(
              child: Text(
                card.text.trim(),
                style: AppText.body.copyWith(color: scheme.onSurface),
              ),
            ),
          ],
          if (repo.isNotEmpty || card.platform != null) ...[
            const SizedBox(height: AppSpace.sm),
            Wrap(
              spacing: AppSpace.xs,
              runSpacing: AppSpace.xxs,
              children: [
                if (repo.isNotEmpty) _Badge(icon: Icons.apps, text: repo),
                // 平台写成中文名：界面上不出现 harmony/android 这种字面量
                if ((card.platform ?? '').isNotEmpty)
                  _Badge(
                    icon: Icons.phone_android_outlined,
                    text: platformLabel(card.platform),
                  ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}

/// 卡片底部的小标签：浅底 + 图标 + 文字。颜色不是唯一载体，图标同时表达语义。
class _Badge extends StatelessWidget {
  const _Badge({required this.icon, required this.text});

  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: AppSpace.xs, vertical: AppSpace.xxs),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerHighest.withValues(alpha: 0.6),
        borderRadius: BorderRadius.circular(AppRadius.small),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 12, color: scheme.onSurfaceVariant),
          const SizedBox(width: AppSpace.xxs),
          Text(
            text,
            style: AppText.label.copyWith(color: scheme.onSurfaceVariant),
          ),
        ],
      ),
    );
  }
}
