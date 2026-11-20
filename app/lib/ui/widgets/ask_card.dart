import 'package:flutter/material.dart';

import '../../api/models.dart';
import '../theme.dart';

/// 消息流里的一张提问卡片（类似 ask_user_question）。
///
/// 以前「需要你拍板」是一段纯文本：「1. 弹窗时机？ A. 首次启动 B. 每次启动」，
/// 用户得在输入框里手打字母。问题一多就记不住第几个题对应哪个选项，
/// 打错一位 agent 就按错的选项往下做，往往要等几步之后才被发现。
/// 卡片把选择变成点选，提交时还能一次把勾选结果结构化发回去。
class AskCardView extends StatefulWidget {
  const AskCardView({
    super.key,
    required this.card,
    required this.canSubmit,
    required this.onSubmit,
    this.answered,
    this.busy = false,
  });

  final AskCard card;

  /// 没有确认权限时只显示、不让提交（和原来的「通过/打回」按钮一致）
  final bool canSubmit;

  /// 已经在本次卡片上提交过的答案：有值就不再允许改，直接显示结果
  final List<MessageAnswer>? answered;

  final bool busy;

  /// 返回 true 表示提交成功，卡片保持只读
  final Future<bool> Function(String text, List<MessageAnswer> answers) onSubmit;

  @override
  State<AskCardView> createState() => _AskCardViewState();
}

class _AskCardViewState extends State<AskCardView> {
  final Map<String, Set<String>> _picked = {};
  final Map<String, TextEditingController> _inputs = {};
  bool _sending = false;
  String? _error;

  @override
  void dispose() {
    for (final c in _inputs.values) {
      c.dispose();
    }
    super.dispose();
  }

  TextEditingController _input(String qid) =>
      _inputs.putIfAbsent(qid, () => TextEditingController());

  bool get _locked => widget.answered != null;

  bool get _canSubmit {
    if (_locked || _sending || widget.busy || !widget.canSubmit) return false;
    // 只要求「至少答了一道」：agent 可能一次问十五个，硬性全答等于不让人提交，
    // 漏掉的那几道它下一轮还会再问
    for (final q in widget.card.questions) {
      final picked = _picked[q.id] ?? const <String>{};
      final typed = (_inputs[q.id]?.text ?? '').trim();
      if (picked.isNotEmpty || typed.isNotEmpty) return true;
    }
    return false;
  }

  void _toggle(AskQuestion q, String optionId) {
    setState(() {
      final set = _picked.putIfAbsent(q.id, () => <String>{});
      if (q.isMulti) {
        set.contains(optionId) ? set.remove(optionId) : set.add(optionId);
      } else {
        // 单选：再点一次取消，方便「我选错了，清掉」
        set.contains(optionId) ? set.clear() : (set
          ..clear()
          ..add(optionId));
      }
      _error = null;
    });
  }

  /// 提交后自动插进消息流的那句话。
  ///
  /// 用户要的是「打回就发打回，通过就发通过，决策就发问题+选项」——
  /// 群里其他人即使没看到卡片，也能从这句话知道刚才决定的是什么。
  String _summary() {
    final card = widget.card;
    if (card.isConfirm) {
      final q = card.questions.first;
      final picked = _picked[q.id] ?? const <String>{};
      if (picked.contains('approve')) return '通过';
      final reason = (_inputs[q.id]?.text ?? '').trim();
      if (picked.contains('reject')) return reason.isEmpty ? '打回' : '打回：$reason';
      return reason;
    }
    final lines = <String>[];
    var n = 0;
    for (final q in card.questions) {
      final picked = _picked[q.id] ?? const <String>{};
      final typed = (_inputs[q.id]?.text ?? '').trim();
      // 没答的题不进这句话：十五道里答了三道，群里只该出现三行
      if (picked.isEmpty && typed.isEmpty) continue;
      n++;
      final labels = <String>[];
      for (var j = 0; j < q.options.length; j++) {
        if (picked.contains(q.options[j].id)) {
          labels.add('${String.fromCharCode(65 + j)}. ${q.options[j].label}');
        }
      }
      if (typed.isNotEmpty) {
        // 自己写的排最后一个选项的位置，和下发的选项字母对得上
        labels.add('${String.fromCharCode(65 + q.options.length)}. $typed');
      }
      lines.add('$n. ${q.title} ${labels.join('  ')}'.trimRight());
    }
    return lines.join('\n');
  }

  List<MessageAnswer> _answers() => [
    for (final q in widget.card.questions)
      // 没答的题不发：引擎那边按 qid 对位取选项，空答案只会让回答块变长
      if ((_picked[q.id] ?? const <String>{}).isNotEmpty ||
          (_inputs[q.id]?.text ?? '').trim().isNotEmpty)
        MessageAnswer(
          qid: q.id,
          optionIds: (_picked[q.id] ?? const <String>{}).toList(),
          input: (_inputs[q.id]?.text ?? '').trim(),
        ),
  ];

  Future<void> _submit() async {
    if (!_canSubmit) return;
    setState(() {
      _sending = true;
      _error = null;
    });
    final ok = await widget.onSubmit(_summary(), _answers());
    if (!mounted) return;
    setState(() {
      _sending = false;
      if (!ok) _error = '没提交成功，稍后再试一次';
    });
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final card = widget.card;
    final answered = widget.answered;

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(AppSpace.md),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerLow,
        borderRadius: BorderRadius.circular(AppRadius.medium),
        border: Border.all(color: scheme.outlineVariant.withValues(alpha: 0.6)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.smart_toy_outlined, size: 20, color: scheme.primary),
              const SizedBox(width: AppSpace.xs),
              Expanded(
                child: Text(
                  card.title,
                  style: AppText.label.copyWith(color: scheme.primary),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpace.sm),
          for (var i = 0; i < card.questions.length; i++) ...[
            if (i > 0) const SizedBox(height: AppSpace.md),
            _Question(
              index: card.questions.length > 1 ? i + 1 : null,
              question: card.questions[i],
              picked: _picked[card.questions[i].id] ?? const <String>{},
              input: _input(card.questions[i].id),
              enabled: !_locked && !_sending,
              onToggle: (id) => _toggle(card.questions[i], id),
              answered: answered,
            ),
          ],
          if (_error != null) ...[
            const SizedBox(height: AppSpace.sm),
            Text(_error!, style: AppText.bodyS.copyWith(color: scheme.error)),
          ],
          const SizedBox(height: AppSpace.md),
          if (_locked)
            Text(
              '已提交',
              style: AppText.caption.copyWith(color: scheme.onSurfaceVariant),
            )
          else if (!widget.canSubmit)
            Text(
              '通过和打回只有系统管理员能操作',
              style: AppText.caption.copyWith(color: scheme.onSurfaceVariant),
            )
          else
            SizedBox(
              width: double.infinity,
              child: FilledButton(
                onPressed: _canSubmit ? _submit : null,
                child: _sending
                    ? const SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : Text(card.submitLabel),
              ),
            ),
        ],
      ),
    );
  }
}

class _Question extends StatelessWidget {
  const _Question({
    required this.question,
    required this.picked,
    required this.input,
    required this.enabled,
    required this.onToggle,
    required this.index,
    this.answered,
  });

  final AskQuestion question;
  final Set<String> picked;
  final TextEditingController input;
  final bool enabled;
  final void Function(String optionId) onToggle;
  final int? index;
  final List<MessageAnswer>? answered;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    MessageAnswer? mine;
    for (final a in answered ?? const <MessageAnswer>[]) {
      if (a.qid == question.id) {
        mine = a;
        break;
      }
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          index == null ? question.title : '$index. ${question.title}',
          style: AppText.body.copyWith(fontWeight: FontWeight.w600),
        ),
        const SizedBox(height: AppSpace.xs),
        for (var i = 0; i < question.options.length; i++)
          Padding(
            padding: const EdgeInsets.only(bottom: AppSpace.xxs),
            child: _OptionRow(
              label: question.options[i].label,
              selected: (mine?.optionIds ?? picked).contains(question.options[i].id),
              multi: question.isMulti,
              enabled: enabled && mine == null,
              onTap: () => onToggle(question.options[i].id),
            ),
          ),
        if (mine != null && mine.input.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: AppSpace.xxs),
            child: Text(
              '补充：${mine.input}',
              style: AppText.bodyS.copyWith(color: scheme.onSurfaceVariant),
            ),
          ),
        if (question.allowInput && mine == null)
          Padding(
            padding: const EdgeInsets.only(top: AppSpace.xs),
            child: TextField(
              controller: input,
              enabled: enabled,
              minLines: 1,
              maxLines: 3,
              style: AppText.bodyS,
              decoration: InputDecoration(hintText: question.inputLabel),
            ),
          ),
      ],
    );
  }
}

class _OptionRow extends StatelessWidget {
  const _OptionRow({
    required this.label,
    required this.selected,
    required this.multi,
    required this.enabled,
    required this.onTap,
  });

  final String label;
  final bool selected;
  final bool multi;
  final bool enabled;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final mark = multi
        ? (selected ? Icons.check_box : Icons.check_box_outline_blank)
        : (selected ? Icons.radio_button_checked : Icons.radio_button_unchecked);

    return InkWell(
      onTap: enabled ? onTap : null,
      borderRadius: BorderRadius.circular(AppRadius.small),
      child: Padding(
        // 整行可点，热区靠内边距撑到 44 以上
        padding: const EdgeInsets.symmetric(vertical: AppSpace.sm - AppSpace.xxs / 2),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(
              mark,
              size: 20,
              color: selected ? scheme.primary : scheme.onSurfaceVariant,
            ),
            const SizedBox(width: AppSpace.xs),
            Expanded(
              child: Text(
                label,
                style: AppText.bodyS.copyWith(
                  color: selected ? scheme.onSurface : scheme.onSurfaceVariant,
                  fontWeight: selected ? FontWeight.w600 : FontWeight.w400,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
