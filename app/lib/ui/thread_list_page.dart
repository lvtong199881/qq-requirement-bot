import 'package:flutter/material.dart';

import '../api/models.dart';
import '../state/auth.dart';
import '../state/threads.dart';
import 'format.dart';
import 'theme.dart';
import 'thread_detail_page.dart';
import 'users_page.dart';
import 'widgets/stage.dart';

/// 需求列表。
///
/// 设计取向：这是「处理待办」的界面，不是社交信息流。所以
/// 1) 等我拍板的排最前并单独分组；
/// 2) 每行都给出「现在在哪一步 + 状态」，而不是只留个标题；
/// 3) 不做未读数红点——用户已经说了不需要推送，一个数字反而
///    增加解释成本，把「等你确认」置顶更直接。
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

  Future<void> _create() async {
    final text = await showDialog<String>(
      context: context,
      builder: (_) => const _NewThreadDialog(),
    );
    if (text == null || text.trim().isEmpty) return;
    try {
      final t = await widget.controller.create(text.trim());
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
          title: const Text('需求'),
          actions: [
            IconButton(
              tooltip: '刷新',
              icon: const Icon(Icons.refresh),
              onPressed: () => widget.controller.refresh(),
            ),
            IconButton(
              tooltip: '账号',
              icon: const Icon(Icons.person_outline),
              onPressed: () => _showAccount(context),
            ),
          ],
        ),
        floatingActionButton: widget.auth.perms.startRequirement
            ? FloatingActionButton.extended(
                onPressed: _create,
                icon: const Icon(Icons.add),
                label: const Text('提需求'),
              )
            // 没权限就不显示按钮，而不是显示了点完再告诉你不行。
            // 权限本身由后端再判一次，这里只是别骗用户。
            : null,
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
      return _EmptyState(canCreate: widget.auth.perms.startRequirement, onCreate: _create);
    }

    final waiting = c.threads.where((t) => t.needsMe).toList();
    final others = c.threads.where((t) => !t.needsMe).toList();

    return RefreshIndicator(
      onRefresh: () => c.refresh(),
      child: ListView(
        padding: const EdgeInsets.fromLTRB(14, 8, 14, 96),
        children: [
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

  void _showAccount(BuildContext context) {
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (ctx) {
        final u = widget.auth.user;
        final theme = Theme.of(ctx);
        return SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(u?.displayName ?? '未登录', style: theme.textTheme.titleMedium),
                const SizedBox(height: 4),
                Text(
                  '${u?.username ?? ''} · ${u?.roleLabel ?? ''}',
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
                const SizedBox(height: 14),
                Text(
                  widget.auth.baseUrl,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
                const SizedBox(height: 18),
                // 账号管理只对管理员出现。用 perms 而不是 user.isAdmin：
                // 「谁能管账号」的规则归后端，前端跟着 /api/auth/me 走。
                if (widget.auth.perms.command)
                  OutlinedButton.icon(
                    onPressed: () {
                      Navigator.of(ctx).pop();
                      Navigator.of(context).push(
                        MaterialPageRoute<void>(
                          builder: (_) => UsersPage(auth: widget.auth),
                        ),
                      );
                    },
                    icon: const Icon(Icons.group_outlined),
                    label: const Text('账号管理'),
                  ),
                if (widget.auth.perms.command) const SizedBox(height: 8),
                OutlinedButton.icon(
                  onPressed: () {
                    Navigator.of(ctx).pop();
                    Navigator.of(context).push(
                      MaterialPageRoute<void>(
                        builder: (_) => const _Placeholder(),
                      ),
                    );
                  },
                  icon: const Icon(Icons.dns_outlined),
                  label: const Text('换服务器（需重新登录）'),
                ),
                const SizedBox(height: 8),
                OutlinedButton.icon(
                  onPressed: () async {
                    Navigator.of(ctx).pop();
                    await widget.auth.logout();
                  },
                  icon: const Icon(Icons.logout),
                  label: const Text('退出登录'),
                ),
              ],
            ),
          ),
        );
      },
    );
  }
}

/// 换服务器目前只能「退出登录后到登录页点右上角」。这里不做跳转，
/// 留个说明比给一个半成品的入口好。
class _Placeholder extends StatelessWidget {
  const _Placeholder();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(),
      body: const Padding(
        padding: EdgeInsets.all(20),
        child: Text('先退出登录，然后在登录页右上角可以换服务器地址。'),
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
                        t.stage ?? '',
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
            Text('还没有需求', style: theme.textTheme.titleMedium),
            const SizedBox(height: 6),
            Text(
              canCreate ? '点右下角说一句你要什么，agent 会接着往下做。' : '等管理员发起第一个需求。',
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
                label: const Text('提需求'),
              ),
            ],
          ],
        ),
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
            Text('拉不到需求', style: theme.textTheme.titleMedium),
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

/// 新建需求的输入框。
///
/// 只有一个多行输入 + 一句提示。不做「标题 / 优先级 / 截止日期」
/// 那套表单：这正是这个项目要取代的东西——直接说人话，
/// 后面的澄清由 agent 反问。
class _NewThreadDialog extends StatefulWidget {
  const _NewThreadDialog();

  @override
  State<_NewThreadDialog> createState() => _NewThreadDialogState();
}

class _NewThreadDialogState extends State<_NewThreadDialog> {
  final _text = TextEditingController();

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('提个需求'),
      content: TextField(
        controller: _text,
        autofocus: true,
        maxLines: 6,
        minLines: 3,
        textInputAction: TextInputAction.newline,
        decoration: const InputDecoration(
          hintText: '比如：首页加一个欢迎弹窗，新用户第一次进来时显示，可以关掉。',
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('取消'),
        ),
        FilledButton(
          onPressed: () => Navigator.of(context).pop(_text.text),
          child: const Text('发出去'),
        ),
      ],
    );
  }
}
