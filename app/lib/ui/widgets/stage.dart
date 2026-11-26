import 'package:flutter/material.dart';

import 'package:base/base.dart';
import 'package:network/network.dart';


/// 阶段徽章：一个小圆点 + 状态词。
///
/// 状态不能只靠颜色区分（规范硬约束），所以这里始终带文字，
/// 圆点只是让人一眼扫到颜色，摘掉文字就失去了一半信息。
class StageBadge extends StatelessWidget {
  const StageBadge({super.key, required this.status, this.dense = false});

  final String? status;

  /// 列表卡片里用密集版，高度少 4。
  final bool dense;

  @override
  Widget build(BuildContext context) {
    final s = status?.trim() ?? '';
    if (s.isEmpty) return const SizedBox.shrink();
    final color = AppColors.stage(context, s);
    return Container(
      padding: EdgeInsets.symmetric(
        horizontal: AppSpace.xs,
        vertical: dense ? AppSpace.xxs / 2 : AppSpace.xxs,
      ),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.14),
        borderRadius: BorderRadius.circular(AppRadius.pill),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          _Dot(color: color),
          const SizedBox(width: AppSpace.xxs),
          Text(
            s,
            style: AppText.caption.copyWith(
              fontSize: dense ? 11 : 12,
              fontWeight: FontWeight.w600,
              color: color,
            ),
          ),
        ],
      ),
    );
  }
}

class _Dot extends StatelessWidget {
  const _Dot({required this.color});

  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 6,
      height: 6,
      decoration: BoxDecoration(color: color, shape: BoxShape.circle),
    );
  }
}

/// 一排格子表示十个主阶段，过一格填一格。
///
/// 格子只用颜色区分进度，所以下面紧跟一行文字（当前阶段名 + 已完成/总数），
/// 色弱用户不看颜色也能知道走到哪了。
class StageProgress extends StatelessWidget {
  const StageProgress({super.key, required this.stages, this.currentLabel});

  final List<Stage> stages;
  final String? currentLabel;

  bool get _empty => stages.isEmpty;

  String get _currentName {
    if (_empty) return currentLabel ?? '';
    for (final s in stages) {
      if (s.active) return s.name;
    }
    for (final s in stages.reversed) {
      if (s.done) return '${s.name} · 已完成';
    }
    return currentLabel ?? stages.first.name;
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    if (_empty) {
      final label = currentLabel?.trim() ?? '';
      if (label.isEmpty) return const SizedBox.shrink();
      return Text(label, style: AppText.bodyS.copyWith(color: theme.colorScheme.onSurfaceVariant));
    }

    final finished = stages.where((s) => s.done).length;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            for (var i = 0; i < stages.length; i++) ...[
              if (i > 0) const SizedBox(width: AppSpace.xxs),
              Expanded(child: _Cell(stage: stages[i])),
            ],
          ],
        ),
        const SizedBox(height: AppSpace.xs),
        Row(
          children: [
            Expanded(
              child: Text(
                _currentName,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: AppText.bodyS.copyWith(color: theme.colorScheme.onSurfaceVariant),
              ),
            ),
            const SizedBox(width: AppSpace.xs),
            Text(
              '$finished / ${stages.length}',
              style: AppText.caption.copyWith(color: theme.colorScheme.onSurfaceVariant),
            ),
          ],
        ),
      ],
    );
  }
}

class _Cell extends StatelessWidget {
  const _Cell({required this.stage});

  final Stage stage;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    // 未开始的格子才用底色；跑过的按状态上色——卡住的格子必须能一眼看出来，
    // 否则「卡在需求澄清」和「还没到需求澄清」长得一模一样
    final color = stage.status.isEmpty || stage.status == '未开始'
        ? scheme.onSurface.withValues(alpha: 0.12)
        : AppColors.stage(context, stage.status);
    return Tooltip(
      message: '${stage.name}：${stage.status}',
      waitDuration: const Duration(milliseconds: 600),
      child: Container(
        height: 6,
        decoration: BoxDecoration(
          color: color,
          borderRadius: BorderRadius.circular(AppRadius.pill),
        ),
      ),
    );
  }
}
