import 'package:flutter/material.dart';

import 'package:base/base.dart';
import 'package:login/login.dart';

import 'scan_page.dart';

/// 设置（二级页）。
///
/// 现在只有服务器地址一项。做成独立页面而不是塞进「我的」一行，
/// 是因为改地址要跳到连接页、还要处理「改完会退出登录」，
/// 展开写清楚比塞一个 subtitle 更不容易误操作。
class SettingsPage extends StatelessWidget {
  const SettingsPage({super.key, required this.auth});

  final AuthController auth;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('设置')),
      body: ListView(
        padding: const EdgeInsets.only(top: AppSpace.xs, bottom: AppSpace.xl),
        children: [
          ListTile(
            leading: const Icon(Icons.dns_outlined),
            title: const Text('服务器地址'),
            subtitle: Text(
              auth.baseUrl,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
            ),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => ServerSetupPage(
                  auth: auth,
                  initialUrl: auth.baseUrl,
                  inSettings: true,
                  scanPage: (_) => const ScanPage(),
                ),
              ),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(
              AppInset.form,
              AppSpace.xs,
              AppInset.form,
              0,
            ),
            child: Text(
              // 说清后果，否则人不知道自己点完会不会被踢出去
              '换服务器后需要重新登录。原来那台服务器上的群不会跟着过来。',
              style: AppText.bodyS.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
                height: 1.5,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
