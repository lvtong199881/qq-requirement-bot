import 'package:flutter/material.dart';

import '../api/models.dart';
import '../state/auth.dart';
import 'settings_page.dart';
import 'theme.dart';
import 'users_page.dart';

/// 「我的」：当前账号 + 设置入口 + 退出登录。
///
/// 账号相关的东西从群列表右上角挪到这里：列表页是处理待办的，
/// 退出登录、改服务器这些低频操作混在上面，既容易误触也占地方。
class MePage extends StatelessWidget {
  const MePage({super.key, required this.auth});

  final AuthController auth;

  Future<void> _confirmLogout(BuildContext context) async {
    final scheme = Theme.of(context).colorScheme;
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
          // 破坏性操作放右侧、用错误色：位置和颜色都在说「这一步会丢状态」
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            style: FilledButton.styleFrom(
              backgroundColor: scheme.error,
              foregroundColor: scheme.onError,
            ),
            child: const Text('退出'),
          ),
        ],
      ),
    );
    if (ok == true) await auth.logout();
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return AnimatedBuilder(
      animation: auth,
      builder: (context, _) {
        final u = auth.user;
        return Scaffold(
          appBar: AppBar(title: const Text('我的')),
          body: ListView(
            padding: const EdgeInsets.only(top: AppSpace.xs, bottom: AppSpace.xl),
            children: [
              _AccountHeader(user: u),
              const SizedBox(height: AppSpace.xs),
              ListTile(
                leading: const Icon(Icons.dns_outlined),
                title: const Text('服务器地址'),
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
              const Padding(
                padding: EdgeInsets.symmetric(vertical: AppSpace.sm),
                child: Divider(),
              ),
              ListTile(
                leading: Icon(Icons.logout, color: scheme.error),
                title: Text('退出登录', style: TextStyle(color: scheme.error)),
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
      padding: const EdgeInsets.fromLTRB(
        AppInset.form,
        AppSpace.md,
        AppInset.form,
        AppSpace.md,
      ),
      child: Row(
        children: [
          CircleAvatar(
            radius: AppSpace.xl,
            backgroundColor: theme.colorScheme.primaryContainer,
            child: Text(
              initial,
              style: AppText.titleM.copyWith(color: theme.colorScheme.onPrimaryContainer),
            ),
          ),
          const SizedBox(width: AppSpace.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  name,
                  style: AppText.titleS.copyWith(color: theme.colorScheme.onSurface),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                const SizedBox(height: AppSpace.xxs),
                Text(
                  '${user?.username ?? ''} · ${user?.roleLabel ?? ''}',
                  style: AppText.bodyS.copyWith(color: theme.colorScheme.onSurfaceVariant),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
