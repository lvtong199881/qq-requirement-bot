import 'package:flutter/material.dart';

import 'package:base/base.dart';
import 'package:network/network.dart';

import '../../state/detail.dart';

/// 「发起新需求」弹窗。
///
/// 以前起需求要在聊天框里 @ 一下再写一段话，然后由 agent 猜「这是哪个项目的
/// 需求、该怎么拆」。猜错就得返工。现在三件事让人自己填：要做什么、叫什么、
/// 打到哪个 APP —— 目标 APP 是下拉选的，不再是自由文本，选不到就是选不到。
///
/// 返回 true 表示提交成功（页面据此滚到底/清提示），false 或 null 表示放弃。
class NewRequirementDialog extends StatefulWidget {
  const NewRequirementDialog({super.key, required this.controller});

  final ThreadDetailController controller;

  @override
  State<NewRequirementDialog> createState() => _NewRequirementDialogState();
}

class _NewRequirementDialogState extends State<NewRequirementDialog> {
  final _text = TextEditingController();
  final _name = TextEditingController();

  List<Repo>? _repos;
  String? _repoId;
  String? _loadError;
  String? _submitError;
  bool _loadingRepos = true;
  bool _submitting = false;

  @override
  void initState() {
    super.initState();
    // 输入内容变化要重算提交按钮的可用性（内容为空时按钮是灰的）
    _text.addListener(_onChanged);
    _loadRepos();
  }

  @override
  void dispose() {
    _text.removeListener(_onChanged);
    _text.dispose();
    _name.dispose();
    super.dispose();
  }

  void _onChanged() {
    if (!mounted) return;
    setState(() {
      // 用户开始改内容就把上一次的报错收掉，别让旧错误压着新输入
      if (_submitError != null) _submitError = null;
    });
  }

  Future<void> _loadRepos() async {
    setState(() {
      _loadingRepos = true;
      _loadError = null;
    });
    try {
      final list = await widget.controller.loadRepos();
      if (!mounted) return;
      setState(() {
        _repos = list;
        _loadingRepos = false;
        // 只有一个仓库时直接选中：少一次点击，也不会选错
        if (list.length == 1) _repoId = list.first.id;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _loadingRepos = false;
        _loadError = e.message;
      });
    }
  }

  bool get _canSubmit {
    if (_submitting) return false;
    if (_text.text.trim().isEmpty) return false;
    if (_repoId == null) return false;
    return true;
  }

  Future<void> _submit() async {
    if (!_canSubmit) return;
    setState(() {
      _submitting = true;
      _submitError = null;
    });
    final err = await widget.controller.startRequirement(
      text: _text.text,
      name: _name.text,
      repoId: _repoId!,
    );
    if (!mounted) return;
    if (err == null) {
      Navigator.of(context).pop(true);
      return;
    }
    setState(() {
      _submitting = false;
      _submitError = err;
    });
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;

    return AlertDialog(
      // 键盘弹起来时对话框整体上移，不靠 position 硬顶
      insetPadding: const EdgeInsets.symmetric(
        horizontal: AppInset.form,
        vertical: AppSpace.xxl,
      ),
      title: const Text('发起新需求'),
      content: SizedBox(
        width: 420,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              TextField(
                controller: _text,
                autofocus: true,
                minLines: 3,
                maxLines: 6,
                enabled: !_submitting,
                style: AppText.body.copyWith(color: scheme.onSurface),
                decoration: const InputDecoration(
                  labelText: '需求内容',
                  hintText: '想让它做什么？说清楚要什么、不要什么',
                  alignLabelWithHint: true,
                ),
              ),
              const SizedBox(height: AppSpace.md),
              TextField(
                controller: _name,
                enabled: !_submitting,
                textInputAction: TextInputAction.next,
                style: AppText.body.copyWith(color: scheme.onSurface),
                decoration: const InputDecoration(
                  labelText: '需求名称（可选）',
                  helperText: '不填就用需求内容起一个',
                ),
              ),
              const SizedBox(height: AppSpace.md),
              _buildRepoField(context),
              if (_submitError != null) ...[
                const SizedBox(height: AppSpace.md),
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Icon(Icons.error_outline, size: 16, color: AppColors.blocked(context)),
                    const SizedBox(width: AppSpace.xs),
                    // 错误也带图标，不只靠红字——状态要两种载体的老规矩
                    Expanded(
                      child: Text(
                        _submitError!,
                        style: AppText.bodyS.copyWith(color: AppColors.blocked(context)),
                      ),
                    ),
                  ],
                ),
              ],
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: _submitting ? null : () => Navigator.of(context).pop(false),
          child: const Text('取消'),
        ),
        FilledButton(
          onPressed: _canSubmit ? _submit : null,
          child: _submitting
              ? const SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Text('提交'),
        ),
      ],
    );
  }

  Widget _buildRepoField(BuildContext context) {
    final theme = Theme.of(context);
    if (_loadingRepos) {
      return Row(
        children: [
          const SizedBox(
            width: 16,
            height: 16,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
          const SizedBox(width: AppSpace.xs),
          Text('正在读取项目列表…', style: AppText.bodyS.copyWith(color: theme.colorScheme.onSurfaceVariant)),
        ],
      );
    }
    if (_loadError != null) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            '项目列表没读到：$_loadError',
            style: AppText.bodyS.copyWith(color: AppColors.blocked(context)),
          ),
          const SizedBox(height: AppSpace.xs),
          OutlinedButton(onPressed: _loadRepos, child: const Text('重试')),
        ],
      );
    }
    final repos = _repos ?? const <Repo>[];
    if (repos.isEmpty) {
      // 空态要说清「去哪配」，不然用户只能猜
      return Text(
        '还没有配置项目。先去管理面板的「项目」页加一个仓库，回来再发起需求。',
        style: AppText.bodyS.copyWith(color: theme.colorScheme.onSurfaceVariant),
      );
    }
    return DropdownButtonFormField<String>(
      initialValue: _repoId,
      decoration: const InputDecoration(labelText: '目标 APP'),
      items: [
        for (final r in repos)
          DropdownMenuItem(
            value: r.id,
            child: Text('${r.name}（${platformLabel(r.platform)}）'),
          ),
      ],
      onChanged: _submitting
          ? null
          : (v) => setState(() {
                _repoId = v;
                _submitError = null;
              }),
    );
  }
}
