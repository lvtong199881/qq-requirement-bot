import 'package:flutter/material.dart';

import '../../api/models.dart';
import '../theme.dart';

/// 阶段状态小圆点 + 文字。
///
/// 颜色和文案分开画：用户可能色弱，只靠颜色区分「等你确认」和「卡住」
/// 是不行的，所以文字一定带上。
class StageBadge extends StatelessWidget {
  const StageBadge({super.key, required this.status, this.dense = false});

  final String? status;
  final bool dense;

  @override
  Widget build(BuildContext context) {
    if (status == null || status!.isEmpty) return const SizedBox.shrink();
    final color = statusColor(status);
    return Container(
      padding: EdgeInsets.symmetric(horizontal: dense ? 7 : 9, vertical: dense ? 2 : 3),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(20),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: dense ? 5 : 6,
            height: dense ? 5 : 6,
            decoration: BoxDecoration(color: color, shape: BoxShape.circle),
          ),
          const SizedBox(width: 5),
          Text(
            status!,
            style: TextStyle(
              color: color,
              fontSize: dense ? 11 : 12,
              fontWeight: FontWeight.w600,
              height: 1.2,
            ),
          ),
        ],
      ),
    );
  }
}

/// 阶段进度条：一排小格子，已完成的填色、当前的加粗。
///
/// 不用 Stepper：十个阶段竖着排会占满一屏，而用户主要想知道
/// 「走到哪了 / 还剩几步」，横条更快读懂。
class StageProgress extends StatelessWidget {
  const StageProgress({super.key, required this.stages, this.currentLabel});

  final List<Stage> stages;
  final String? currentLabel;

  @override
  Widget build(BuildContext context) {
    if (stages.isEmpty) {
      // 刚建出来还没跑起来的情况
      if (currentLabel == null) return const SizedBox.shrink();
      return Text(
        currentLabel!,
        style: Theme.of(context).textTheme.bodySmall,
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            for (var i = 0; i < stages.length; i++)
              Expanded(
                child: Padding(
                  padding: EdgeInsets.only(right: i == stages.length - 1 ? 0 : 3),
                  child: _Cell(stage: stages[i]),
                ),
              ),
          ],
        ),
        const SizedBox(height: 8),
        Row(
          children: [
            Expanded(
              child: Text(
                _currentName(),
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  fontWeight: FontWeight.w600,
                ),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),
            Text(
              '${stages.where((s) => s.done).length}/${stages.length}',
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ],
        ),
      ],
    );
  }

  /// 优先显示「进行中/等待确认」的那个，没有就显示最后一个已完成的。
  String _currentName() {
    for (final s in stages) {
      if (s.active) return s.name;
    }
    final done = stages.where((s) => s.done).toList();
    if (done.isNotEmpty) return '${done.last.name} · 已完成';
    return stages.first.name;
  }
}

class _Cell extends StatelessWidget {
  const _Cell({required this.stage});

  final Stage stage;

  @override
  Widget build(BuildContext context) {
    final color = statusColor(stage.status);
    return Tooltip(
      message: '${stage.name}：${stage.status}',
      child: Container(
        height: 5,
        decoration: BoxDecoration(
          color: stage.done || stage.active || stage.blocked
              ? color
              : Theme.of(context).colorScheme.surfaceContainerHighest,
          borderRadius: BorderRadius.circular(3),
        ),
      ),
    );
  }
}

/// 中文状态 → 颜色。实现只有一份（theme.dart 的 AppColors），
/// 这里留个别名是为了让页面只 import 这一个文件。
Color statusColor(String? status) => AppColors.forStageStatus(status);
