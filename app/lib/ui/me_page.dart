import 'package:flutter/material.dart';

import '../api/models.dart';
import '../state/auth.dart';
import 'settings_page.dart';
import 'users_page.dart';

/// 「我的」：当前账号 + 设置入口 + 退出登录。
///
/// 账号相关的东西从需求列表右上角挪到这里：列表页是处理待办的，
/// 退出登录、改服务器这些低频操作混在上面，既容易误触也占地方。
class MePage extends StatelessWidget {
  const MePage({super.key, required this.auth});

  final AuthController auth;

  Future<void> _confirmLogout(BuildContext context) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('退出登录？'),
        content: const Text('退出后需要重新输入账号密码。服务器地址会保留。'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('退出'),
          ),
        ],
      ),
    );
    if (ok == true) await auth.logout();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: auth,
      builder: (context, _) {
        final u = auth.user;
        return Scaffold(
          appBar: AppBar(title: const Text('我的')),
          body: ListView(
            padding: const EdgeInsets.only(top: 10, bottom: 24),
            children: [
              _AccountHeader(user: u),
              const SizedBox(height: 6),
              ListTile(
                leading: const Icon(Icons.settings_outlined),
                title: const Text('设置'),
                subtitle: Text(
                  auth.baseUrl,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (_) => SettingsPage(auth: auth),
                  ),
                ),
              ),
              // 账号管理只对管理员出现。规则归后端，前端跟着 /api/auth/me 的
              // perms 走，不要在这里硬编码 role == 'admin'。
              if (auth.perms.command)
                ListTile(
                  leading: const Icon(Icons.group_outlined),
                  title: const Text('账号管理'),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => Navigator.of(context).push(
                    MaterialPageRoute<void>(
                      builder: (_) => UsersPage(auth: auth),
                    ),
                  ),
                ),
              const Divider(height: 24),
              ListTile(
                leading: Icon(Icons.logout, color: Theme.of(context).colorScheme.error),
                title: Text(
                  '退出登录',
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
                onTap: () => _confirmLogout(context),
              ),
            ],
          ),
        );
      },
    );
  }
}

class _AccountHeader extends StatelessWidget {
  const _AccountHeader({required this.user});

  final User? user;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final name = user?.displayName ?? '未登录';
    final initial = name.isEmpty ? '?' : name.substring(0, 1);
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 10, 20, 10),
      child: Row(
        children: [
          CircleAvatar(
            radius: 28,
            backgroundColor: theme.colorScheme.primaryContainer,
            child: Text(
              initial,
              style: theme.textTheme.titleLarge?.copyWith(
                color: theme.colorScheme.onPrimaryContainer,
              ),
            ),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  name,
                  style: theme.textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w600,
                  ),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                const SizedBox(height: 3),
                Text(
                  '${user?.username ?? ''} · ${user?.roleLabel ?? ''}',
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
