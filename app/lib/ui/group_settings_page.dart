import 'package:flutter/material.dart';

import '../api/models.dart';
import '../state/auth.dart';
import '../state/group_settings.dart';
import 'group_qr_page.dart';
import 'theme.dart';
import 'widgets/avatar.dart';
import 'widgets/toast.dart';

/// 群设置：群信息 / 群成员 / 群聊信息。
///
/// 三块按用户在群里想干的事排序——先确认「这是哪个群」，再看「都有谁」，
/// 最后才是「怎么把别人拉进来」。
class GroupSettingsPage extends StatefulWidget {
  const GroupSettingsPage({
    super.key,
    required this.auth,
    required this.threadId,
    this.seed,
  });

  final AuthController auth;
  final String threadId;
  final Thread? seed;

  @override
  State<GroupSettingsPage> createState() => _GroupSettingsPageState();
}

class _GroupSettingsPageState extends State<GroupSettingsPage> {
  late final GroupSettingsController _c;

  @override
  void initState() {
    super.initState();
    _c = GroupSettingsController(
      auth: widget.auth,
      threadId: widget.threadId,
      seed: widget.seed,
    )..start();
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  Future<void> _rename() async {
    if (!_c.canRename) {
      showToast(context, '只有系统管理员和群管理员能改群名');
      return;
    }
    final name = await showDialog<String>(
      context: context,
      builder: (_) => _RenameDialog(initial: _c.groupName),
    );
    if (name == null || !mounted) return;
    final err = await _c.rename(name);
    if (!mounted) return;
    showToast(context, err ?? '群名已改');
  }

  Future<void> _confirmRole(GroupMember m) async {
    final toAdmin = !m.isAdmin;
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(toAdmin ? '把 ${m.nickname} 设为群管理员？' : '取消 ${m.nickname} 的管理员？'),
        content: Text(
          toAdmin ? '群管理员能改群名、能指定别人当管理员。' : '取消后就只能聊天，不能改群名。',
          style: AppText.bodyS,
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: Text(toAdmin ? '设为管理员' : '取消管理员'),
          ),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    final err = await _c.setRole(m.userId, toAdmin ? 'admin' : 'member');
    if (!mounted) return;
    showToast(context, err ?? (toAdmin ? '已设为群管理员' : '已取消群管理员'));
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _c,
      builder: (context, _) {
        return Scaffold(
          appBar: AppBar(title: const Text('群设置')),
          body: _body(),
        );
      },
    );
  }

  Widget _body() {
    if (_c.loading && _c.members == null) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_c.error != null && _c.members == null) {
      return Padding(
        padding: const EdgeInsets.all(AppInset.page),
        child: _ErrorBox(message: _c.error!, onRetry: _c.refresh),
      );
    }
    final members = _c.members?.members ?? const <GroupMember>[];
    return ListView(
      padding: const EdgeInsets.fromLTRB(
        AppInset.page,
        AppSpace.md,
        AppInset.page,
        AppSpace.xl,
      ),
      children: [
        _InfoCard(
          name: _c.groupName,
          threadId: widget.threadId,
          onTap: _rename,
        ),
        const SizedBox(height: AppSpace.md),
        _MembersCard(
          members: members,
          canManage: _c.canManage,
          onTapMember: _confirmRole,
        ),
        const SizedBox(height: AppSpace.md),
        _ChatInfoCard(
          name: _c.groupName,
          threadId: widget.threadId,
          onRename: _rename,
          onQr: () => Navigator.of(context).push(
            MaterialPageRoute(
              builder: (_) => GroupQrPage(
                threadId: widget.threadId,
                groupName: _c.groupName,
              ),
            ),
          ),
        ),
      ],
    );
  }
}

class _InfoCard extends StatelessWidget {
  const _InfoCard({required this.name, required this.threadId, required this.onTap});

  final String name;
  final String threadId;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Card(
      margin: EdgeInsets.zero,
      child: InkWell(
        borderRadius: BorderRadius.circular(AppRadius.medium),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(AppSpace.md),
          child: Row(
            children: [
              InitialAvatar(name: name, size: 48),
              const SizedBox(width: AppSpace.md),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(name, style: AppText.titleS, maxLines: 1, overflow: TextOverflow.ellipsis),
                    const SizedBox(height: AppSpace.xxs),
                    Text(
                      '群号 $threadId',
                      style: AppText.bodyS.copyWith(color: scheme.onSurfaceVariant),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ],
                ),
              ),
              Icon(Icons.edit_outlined, size: 20, color: scheme.onSurfaceVariant),
            ],
          ),
        ),
      ),
    );
  }
}

class _MembersCard extends StatelessWidget {
  const _MembersCard({
    required this.members,
    required this.canManage,
    required this.onTapMember,
  });

  final List<GroupMember> members;
  final bool canManage;
  final void Function(GroupMember) onTapMember;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(AppSpace.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Text('群成员', style: AppText.titleS),
                const SizedBox(width: AppSpace.xs),
                Text('${members.length}', style: AppText.bodyS.copyWith(color: scheme.onSurfaceVariant)),
                const Spacer(),
                if (canManage)
                  Text('点头像可设管理员', style: AppText.caption.copyWith(color: scheme.onSurfaceVariant)),
              ],
            ),
            const SizedBox(height: AppSpace.md),
            // flex 布局：名字长短不一时按行排，不硬算列宽
            Wrap(
              spacing: AppSpace.md,
              runSpacing: AppSpace.md,
              children: [
                for (final m in members)
                  _MemberCell(
                    member: m,
                    onTap: canManage && !m.isOwner && !m.isBot ? () => onTapMember(m) : null,
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _MemberCell extends StatelessWidget {
  const _MemberCell({required this.member, this.onTap});

  final GroupMember member;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return InkWell(
      borderRadius: BorderRadius.circular(AppRadius.small),
      onTap: onTap,
      child: SizedBox(
        width: 56,
        child: Column(
          children: [
            InitialAvatar(name: member.nickname, size: 40, isBot: member.isBot),
            const SizedBox(height: AppSpace.xxs),
            Text(
              member.nickname,
              style: AppText.caption,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              textAlign: TextAlign.center,
            ),
            if (member.isOwner || member.isAdmin)
              Text(
                member.isOwner ? '群主' : '管理员',
                style: AppText.caption.copyWith(color: scheme.primary),
                maxLines: 1,
              ),
          ],
        ),
      ),
    );
  }
}

class _ChatInfoCard extends StatelessWidget {
  const _ChatInfoCard({
    required this.name,
    required this.threadId,
    required this.onRename,
    required this.onQr,
  });

  final String name;
  final String threadId;
  final VoidCallback onRename;
  final VoidCallback onQr;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Card(
      margin: EdgeInsets.zero,
      clipBehavior: Clip.antiAlias,
      child: Column(
        children: [
          ListTile(
            leading: Icon(Icons.badge_outlined, size: 20, color: scheme.onSurfaceVariant),
            title: const Text('群聊名称'),
            subtitle: Text(name, maxLines: 1, overflow: TextOverflow.ellipsis),
            trailing: Icon(Icons.edit_outlined, size: 18, color: scheme.onSurfaceVariant),
            onTap: onRename,
          ),
          const Divider(height: 1),
          ListTile(
            leading: Icon(Icons.tag, size: 20, color: scheme.onSurfaceVariant),
            title: const Text('群号'),
            subtitle: SelectableText(threadId, style: AppText.bodyS),
          ),
          const Divider(height: 1),
          ListTile(
            leading: Icon(Icons.qr_code_2_outlined, size: 20, color: scheme.onSurfaceVariant),
            title: const Text('二维码'),
            subtitle: const Text('扫码就能加群'),
            trailing: Icon(Icons.chevron_right, color: scheme.onSurfaceVariant),
            onTap: onQr,
          ),
        ],
      ),
    );
  }
}

class _RenameDialog extends StatefulWidget {
  const _RenameDialog({required this.initial});

  final String initial;

  @override
  State<_RenameDialog> createState() => _RenameDialogState();
}

class _RenameDialogState extends State<_RenameDialog> {
  late final TextEditingController _input = TextEditingController(text: widget.initial);
  String? _error;

  @override
  void dispose() {
    _input.dispose();
    super.dispose();
  }

  void _submit() {
    final name = _input.text.trim();
    if (name.isEmpty) {
      setState(() => _error = '起个名字吧');
      return;
    }
    Navigator.pop(context, name);
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('改群名'),
      content: TextField(
        controller: _input,
        autofocus: true,
        maxLength: 40,
        textInputAction: TextInputAction.done,
        onSubmitted: (_) => _submit(),
        decoration: InputDecoration(
          labelText: '群名',
          hintText: '比如：首页改版、登录体验',
          errorText: _error,
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
        FilledButton(onPressed: _submit, child: const Text('保存')),
      ],
    );
  }
}

class _ErrorBox extends StatelessWidget {
  const _ErrorBox({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.cloud_off_outlined, size: 48, color: Theme.of(context).colorScheme.outline),
          const SizedBox(height: AppSpace.md),
          Text(message, style: AppText.bodyS, textAlign: TextAlign.center),
          const SizedBox(height: AppSpace.md),
          OutlinedButton(onPressed: onRetry, child: const Text('重试')),
        ],
      ),
    );
  }
}
