import 'package:flutter/material.dart';

import '../api/models.dart';
import '../state/auth.dart';
import '../state/threads.dart';
import 'format.dart';
import 'theme.dart';
import 'thread_detail_page.dart';
import 'widgets/stage.dart';

/// 群列表。
///
/// 流程是「先建群，再在群里走需求」：群是容器，需求是群里跑的那条 flow。
/// 所以这一页的主语是群——建群时只起个名字，真正要做什么等进群之后说。
///
/// 设计取向：这是「处理待办」的界面，不是社交信息流。所以
/// 1) 等我拍板的排最前并单独分组；
/// 2) 每行都给出「现在在哪一步 + 状态」，而不是只留个标题；
/// 3) 不做未读数红点——用户已经说了不需要推送，一个数字反而
///    增加解释成本，把「等你确认」置顶更直接。
///
/// 建群入口不放在这一页的浮动按钮上：底部导航已经占了一条，
/// 再叠一个 FAB 会挡住列表最后一行。放 AppBar 的 + 上，位置稳定又不抢戏。
class ThreadListPage extends StatefulWidget {
  const ThreadListPage({super.key, required this.auth, required this.controller});

  final AuthController auth;
  final ThreadListController controller;

  @override
  State<ThreadListPage> createState() => _ThreadListPageState();
}

class _ThreadListPageState extends State<ThreadListPage> {
  @override
  void initState() {
    super.initState();
    widget.controller.start();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final notice = widget.auth.flashNotice;
      if (notice != null && notice.isNotEmpty) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(notice)));
        widget.auth.consumeNotice();
      }
    });
  }

  @override
  void dispose() {
    widget.controller.stop();
    super.dispose();
  }

  Future<void> _open(Thread t) async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => ThreadDetailPage(
          auth: widget.auth,
          threadId: t.threadId,
          seed: t,
        ),
      ),
    );
    // 回来立刻刷一次：详情页里点了通过/打回，列表状态要跟上
    if (mounted) widget.controller.refresh(silent: true);
  }

  /// 建群。只问名字，不问需求：群先当聊天用，@ 需求 bot 才开流程。
  Future<void> _create() async {
    final name = await showDialog<String>(
      context: context,
      builder: (_) => const _NewGroupDialog(),
    );
    if (name == null) return;
    try {
      final t = await widget.controller.create(name.trim());
      if (!mounted) return;
      await _open(t);
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    }
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: widget.controller,
      builder: (context, _) => Scaffold(
        appBar: AppBar(
          title: const Text('群'),
          actions: [
            if (widget.auth.perms.startRequirement)
              IconButton(
                tooltip: '建群',
                icon: const Icon(Icons.add_comment_outlined),
                onPressed: _create,
              ),
            IconButton(
              tooltip: '刷新',
              icon: const Icon(Icons.refresh),
              onPressed: () => widget.controller.refresh(),
            ),
          ],
        ),
        body: _body(context),
      ),
    );
  }

  Widget _body(BuildContext context) {
    final c = widget.controller;
    if (c.firstLoad && c.loading) {
      return const Center(child: CircularProgressIndicator());
    }
    if (c.error != null && c.threads.isEmpty) {
      return _ErrorState(
        message: c.error!,
        onRetry: () => c.refresh(),
      );
    }
    if (c.threads.isEmpty) {
      return Column(
        children: [
          // 引擎掉线时先说清楚：聊天照旧，只是 @ 了没人接。
          if (c.engineOnline == false) const _EngineOfflineBanner(),
          Expanded(
            child: _EmptyState(
              canCreate: widget.auth.perms.startRequirement,
              onCreate: _create,
            ),
          ),
        ],
      );
    }

    final waiting = c.threads.where((t) => t.needsMe).toList();
    final others = c.threads.where((t) => !t.needsMe).toList();

    return RefreshIndicator(
      onRefresh: () => c.refresh(),
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
        children: [
          if (c.engineOnline == false) const _EngineOfflineBanner(),
          if (waiting.isNotEmpty) ...[
            _SectionLabel(
              text: '等你确认',
              count: waiting.length,
              color: AppColors.waiting,
            ),
            for (final t in waiting) _ThreadCard(thread: t, onTap: () => _open(t)),
            const SizedBox(height: 14),
          ],
          if (others.isNotEmpty) ...[
            if (waiting.isNotEmpty) const _SectionLabel(text: '其它'),
            for (final t in others) _ThreadCard(thread: t, onTap: () => _open(t)),
          ],
        ],
      ),
    );
  }
}

class _SectionLabel extends StatelessWidget {
  const _SectionLabel({required this.text, this.count, this.color});

  final String text;
  final int? count;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(4, 8, 4, 10),
      child: Row(
        children: [
          Text(
            text,
            style: theme.textTheme.labelMedium?.copyWith(
              color: color ?? theme.colorScheme.onSurfaceVariant,
              fontWeight: FontWeight.w700,
              letterSpacing: 0.3,
            ),
          ),
          if (count != null) ...[
            const SizedBox(width: 6),
            Text(
              '$count',
              style: theme.textTheme.labelMedium?.copyWith(
                color: color ?? theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _ThreadCard extends StatelessWidget {
  const _ThreadCard({required this.thread, required this.onTap});

  final Thread thread;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final t = thread;
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Card(
        color: theme.colorScheme.surfaceContainerLow,
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(14),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(14, 13, 14, 13),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(
                      child: Text(
                        t.title,
                        style: theme.textTheme.titleSmall?.copyWith(
                          fontWeight: FontWeight.w600,
                          height: 1.35,
                        ),
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                    if (t.running) ...[
                      const SizedBox(width: 8),
                      SizedBox(
                        width: 13,
                        height: 13,
                        child: CircularProgressIndicator(
                          strokeWidth: 1.8,
                          color: theme.colorScheme.primary,
                        ),
                      ),
                    ],
                  ],
                ),
                const SizedBox(height: 9),
                Row(
                  children: [
                    StageBadge(status: t.stageStatus, dense: true),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        // 聊天群没有阶段，显示「群聊」而不是留空：
                        // 列表里一行空白会让人以为是数据没加载出来。
                        t.stage ??
                            (t.mode == 'chat'
                                ? '群聊'
                                : (t.pending ? '还没提需求' : '')),
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                    Text(
                      Fmt.relative(t.lastActiveAt),
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                        fontSize: 11,
                      ),
                    ),
                  ],
                ),
                if ((t.waitingLabel ?? '').isNotEmpty) ...[
                  const SizedBox(height: 7),
                  Text(
                    t.waitingLabel!,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: AppColors.waiting,
                      height: 1.4,
                    ),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _EmptyState extends StatelessWidget {
  const _EmptyState({required this.canCreate, required this.onCreate});

  final bool canCreate;
  final VoidCallback onCreate;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              Icons.inbox_outlined,
              size: 52,
              color: theme.colorScheme.onSurfaceVariant.withValues(alpha: 0.5),
            ),
            const SizedBox(height: 14),
            Text('还没有群', style: theme.textTheme.titleMedium),
            const SizedBox(height: 6),
            Text(
              canCreate ? '先建个群。想聊天就聊，要干活就 @需求bot 说一句。' : '等管理员建第一个群。',
              textAlign: TextAlign.center,
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
                height: 1.5,
              ),
            ),
            if (canCreate) ...[
              const SizedBox(height: 18),
              FilledButton.icon(
                onPressed: onCreate,
                icon: const Icon(Icons.add),
                label: const Text('建群'),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// 引擎掉线的横幅。
///
/// 不挡住整页：群和消息都在 IM 上，跟引擎死没死没关系。只是「@ 了会不会
/// 有人接」这件事变了，得让用户知道，否则他会以为按钮坏了。
class _EngineOfflineBanner extends StatelessWidget {
  const _EngineOfflineBanner();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: theme.colorScheme.errorContainer,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Row(
        children: [
          Icon(
            Icons.cloud_off_outlined,
            size: 18,
            color: theme.colorScheme.onErrorContainer,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              '需求引擎没连上。群还能照常聊，只是 @需求bot 暂时没人接。',
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onErrorContainer,
                height: 1.4,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _ErrorState extends StatelessWidget {
  const _ErrorState({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.cloud_off_outlined, size: 46, color: theme.colorScheme.error),
            const SizedBox(height: 14),
            Text('拉不到群列表', style: theme.textTheme.titleMedium),
            const SizedBox(height: 8),
            Text(
              message,
              textAlign: TextAlign.center,
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 18),
            OutlinedButton(onPressed: onRetry, child: const Text('重试')),
          ],
        ),
      ),
    );
  }
}

/// 建群的输入框：只要一个名字。
///
/// 这里刻意不收需求描述——群先当普通聊天用，需要 agent 干活时再在群里
/// @ 它一句。先弹窗问需求再建群，等于把「群」降级成需求的包装壳。
class _NewGroupDialog extends StatefulWidget {
  const _NewGroupDialog();

  @override
  State<_NewGroupDialog> createState() => _NewGroupDialogState();
}

class _NewGroupDialogState extends State<_NewGroupDialog> {
  final _name = TextEditingController();

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('建个群'),
      content: TextField(
        controller: _name,
        autofocus: true,
        maxLength: 40,
        textInputAction: TextInputAction.done,
        onSubmitted: (v) => Navigator.of(context).pop(v),
        decoration: const InputDecoration(
          labelText: '群名',
          hintText: '比如：首页改版、登录体验',
          helperText: '先当群聊用，要做事时 @需求bot 说一句。',
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('取消'),
        ),
        FilledButton(
          onPressed: () => Navigator.of(context).pop(_name.text),
          child: const Text('建群'),
        ),
      ],
    );
  }
}
