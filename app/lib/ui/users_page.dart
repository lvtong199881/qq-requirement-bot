import 'package:flutter/material.dart';

import '../api/client.dart';
import '../api/models.dart';
import '../state/auth.dart';
import 'theme.dart';
import 'widgets/toast.dart';

/// 账号管理：只有系统管理员能进（普通成员从「我的」里看不到入口）。
///
/// 为什么要这一页：注册流程故意没做邮箱和找回密码，忘了密码只能靠管理员重置。
/// 如果这一页只存在于 curl 命令里，那「找管理员重置」实际上等于不可用。
///
/// 三条操作都直接打后端，成功后就地刷新列表——不本地改数据再猜，
/// 因为「最后一个管理员不能降级」这类规则在后端，猜错了界面就会说谎。
class UsersPage extends StatefulWidget {
  const UsersPage({super.key, required this.auth});

  final AuthController auth;

  @override
  State<UsersPage> createState() => _UsersPageState();
}

class _UsersPageState extends State<UsersPage> {
  List<User>? _users;
  String? _error;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _error = null);
    try {
      final list = await widget.auth.client.listUsers();
      if (!mounted) return;
      setState(() => _users = list);
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _error = e.message);
    }
  }

  /// 所有写操作走同一条路：置忙 → 请求 → 刷新 → 出错就弹提示。
  Future<void> _run(Future<void> Function() action, String okText) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      await action();
      await _load();
      // 改的可能是自己（比如自己重置了自己密码），顺手刷新权限
      await widget.auth.refreshMe();
      if (!mounted) return;
      _toast(okText);
    } on ApiException catch (e) {
      if (!mounted) return;
      _toast(e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _toast(String text) {
    showToast(context, text);
  }

  Future<void> _resetPassword(User u) async {
    final pwd = await showDialog<String>(
      context: context,
      builder: (_) => _NewPasswordDialog(user: u),
    );
    if (pwd == null) return;
    await _run(
      () => widget.auth.client.resetUserPassword(u.id, pwd),
      '已重置 ${u.displayName} 的密码',
    );
  }

  Future<void> _toggleRole(User u) async {
    final toAdmin = !u.isAdmin;
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(toAdmin ? '设为系统管理员？' : '降为普通成员？'),
        content: Text(
          toAdmin
              ? '${u.displayName} 将能建群、@ 机器人提需求、点通过或打回。'
              : '${u.displayName} 将只能看群、聊天，不能再拍板。',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('取消')),
          // 按钮写动作本身，不写「确定」：用户点完就该知道发生了什么
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            child: Text(toAdmin ? '设为管理员' : '降为成员'),
          ),
        ],
      ),
    );
    if (ok != true) return;
    await _run(
      () => widget.auth.client.setUserRole(u.id, toAdmin ? 'admin' : 'member'),
      toAdmin ? '已设为系统管理员' : '已降为普通成员',
    );
  }

  Future<void> _toggleDisabled(User u) async {
    if (!u.disabled) {
      // 停用会把人立刻踢下线，让管理员先确认一下
      final ok = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: Text('停用 ${u.displayName}？'),
          content: const Text('停用后立刻无法登录，已经登录的也会在下一次请求被拒。'),
          actions: [
            TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('取消')),
            FilledButton(
              onPressed: () => Navigator.of(ctx).pop(true),
              style: FilledButton.styleFrom(
                backgroundColor: Theme.of(ctx).colorScheme.error,
                foregroundColor: Theme.of(ctx).colorScheme.onError,
              ),
              child: const Text('停用'),
            ),
          ],
        ),
      );
      if (ok != true) return;
    }
    await _run(
      () => widget.auth.client.setUserDisabled(u.id, !u.disabled),
      u.disabled ? '已恢复 ${u.displayName}' : '已停用 ${u.displayName}',
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('账号'),
        actions: [
          IconButton(
            onPressed: _busy ? null : _load,
            icon: const Icon(Icons.refresh),
            tooltip: '刷新',
          ),
        ],
      ),
      body: _body(),
    );
  }

  Widget _body() {
    final theme = Theme.of(context);
    // 首屏还没拿到数据时，错误和加载是两种完全不同的状态：
    // 一个要人重试，一个只要等，所以分开画。
    if (_busy && _users == null) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_error != null && _users == null) {
      return _StateBox(
        icon: Icons.people_outline,
        title: '拉不到账号列表',
        message: _error!,
        actionLabel: '重试',
        onAction: _load,
      );
    }
    final users = _users;
    if (users == null) {
      return const Center(child: CircularProgressIndicator());
    }
    if (users.isEmpty) {
      return const _StateBox(
        icon: Icons.person_add_alt,
        title: '还没有别人注册',
        message: '把服务器地址发给他们，在登录页点「注册并登录」就能进来。',
      );
    }

    return ListView.separated(
      padding: const EdgeInsets.fromLTRB(
        AppInset.page,
        AppSpace.sm,
        AppInset.page,
        AppSpace.xxl,
      ),
      itemCount: users.length + 1,
      separatorBuilder: (_, i) =>
          i == 0 ? const SizedBox.shrink() : const SizedBox(height: AppSpace.sm),
      itemBuilder: (context, i) {
        if (i == 0) {
          return Padding(
            padding: const EdgeInsets.only(bottom: AppSpace.sm),
            child: Text(
              '没有找回密码流程，成员忘了密码就在这里重置。'
              '停用的人立刻无法登录，已登录的也会在下一次请求被拒。',
              style: AppText.bodyS.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
                height: 1.5,
              ),
            ),
          );
        }
        final u = users[i - 1];
        return _UserCard(
          user: u,
          isMe: u.id == widget.auth.user?.id,
          busy: _busy,
          onResetPassword: () => _resetPassword(u),
          onToggleRole: () => _toggleRole(u),
          onToggleDisabled: () => _toggleDisabled(u),
        );
      },
    );
  }
}

class _UserCard extends StatelessWidget {
  const _UserCard({
    required this.user,
    required this.isMe,
    required this.busy,
    required this.onResetPassword,
    required this.onToggleRole,
    required this.onToggleDisabled,
  });

  final User user;
  final bool isMe;
  final bool busy;
  final VoidCallback onResetPassword;
  final VoidCallback onToggleRole;
  final VoidCallback onToggleDisabled;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final dim = user.disabled;
    final nameColor = dim ? theme.colorScheme.onSurfaceVariant : theme.colorScheme.onSurface;
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        // 底部留 8：三个文字按钮自己带 12/8 内边距，再加 8 才不贴卡片边
        padding: const EdgeInsets.fromLTRB(AppSpace.md, AppSpace.sm, AppSpace.xs, AppSpace.xs),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    isMe ? '${user.displayName}（我）' : user.displayName,
                    style: AppText.titleS.copyWith(color: nameColor),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                _RoleChip(role: user.role, label: user.roleLabel),
                if (dim) ...[
                  const SizedBox(width: AppSpace.xs),
                  const _RoleChip(role: 'disabled', label: '已停用'),
                ],
              ],
            ),
            const SizedBox(height: AppSpace.xxs),
            Text(
              '@${user.username}',
              style: AppText.bodyS.copyWith(color: theme.colorScheme.onSurfaceVariant),
            ),
            const SizedBox(height: AppSpace.xs),
            // 机器人跟人共用一张账号表，但它不该被当成「人」去管理：
            // 没有密码、不能登录，停用或降级会直接把 @ 它打需求的路掐断。
            if (user.isBot)
              Text(
                '机器人账号：不能登录，也不能停用或改角色。',
                style: AppText.caption.copyWith(color: theme.colorScheme.onSurfaceVariant),
              )
            else
              Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                TextButton(
                  onPressed: busy ? null : onResetPassword,
                  child: const Text('重置密码'),
                ),
                TextButton(
                  onPressed: busy ? null : onToggleRole,
                  child: Text(user.isAdmin ? '降为成员' : '设为管理员'),
                ),
                TextButton(
                  onPressed: busy ? null : onToggleDisabled,
                  style: TextButton.styleFrom(
                    foregroundColor: dim ? null : AppColors.blocked(context),
                  ),
                  child: Text(dim ? '恢复' : '停用'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _RoleChip extends StatelessWidget {
  const _RoleChip({required this.role, required this.label});

  final String role;
  final String label;

  @override
  Widget build(BuildContext context) {
    // 管理员用主题蓝（它是「身份」，不是状态），停用才用糖果粉，
    // 机器人用糖果绿——它不是人，跟这两种身份都不同类
    final color = switch (role) {
      'admin' => Theme.of(context).colorScheme.primary,
      'bot' => AppColors.done(context),
      'disabled' => AppColors.blocked(context),
      _ => AppColors.idle(context),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: AppSpace.xs, vertical: AppSpace.xxs),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.14),
        borderRadius: BorderRadius.circular(AppRadius.pill),
      ),
      child: Text(
        label.isEmpty ? role : label,
        style: AppText.caption.copyWith(color: color, fontWeight: FontWeight.w600),
      ),
    );
  }
}

/// 空态与错误态共用一套骨架：图标 + 标题 + 说明 +（可选）一个动作。
/// 两处各写一遍的话，字号和间距迟早会走样。
class _StateBox extends StatelessWidget {
  const _StateBox({
    required this.icon,
    required this.title,
    required this.message,
    this.actionLabel,
    this.onAction,
  });

  final IconData icon;
  final String title;
  final String message;
  final String? actionLabel;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(AppInset.form),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 48, color: theme.colorScheme.onSurfaceVariant),
            const SizedBox(height: AppSpace.sm),
            Text(title, style: AppText.titleM.copyWith(color: theme.colorScheme.onSurface)),
            const SizedBox(height: AppSpace.xs),
            Text(
              message,
              textAlign: TextAlign.center,
              style: AppText.bodyS.copyWith(color: theme.colorScheme.onSurfaceVariant, height: 1.5),
            ),
            if (actionLabel != null) ...[
              const SizedBox(height: AppSpace.lg),
              OutlinedButton(onPressed: onAction, child: Text(actionLabel!)),
            ],
          ],
        ),
      ),
    );
  }
}

/// 重置密码只让输入新密码，不要「确认密码」两遍。
/// 管理员在帮别人设密码，不是自己在注册，少一个字段少一次打错的机会。
class _NewPasswordDialog extends StatefulWidget {
  const _NewPasswordDialog({required this.user});

  final User user;

  @override
  State<_NewPasswordDialog> createState() => _NewPasswordDialogState();
}

class _NewPasswordDialogState extends State<_NewPasswordDialog> {
  final _pwd = TextEditingController();
  String? _error;

  @override
  void dispose() {
    _pwd.dispose();
    super.dispose();
  }

  void _submit() {
    final v = _pwd.text;
    if (v.length < 6) {
      setState(() => _error = '密码至少 6 位');
      return;
    }
    Navigator.of(context).pop(v);
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text('重置 ${widget.user.displayName} 的密码'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          TextField(
            controller: _pwd,
            autofocus: true,
            decoration: InputDecoration(
              labelText: '新密码',
              helperText: '记得线下告诉对方',
              errorText: _error,
            ),
            onSubmitted: (_) => _submit(),
          ),
        ],
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('取消')),
        FilledButton(onPressed: _submit, child: const Text('重置密码')),
      ],
    );
  }
}
