import 'package:flutter/material.dart';

import '../../api/models.dart';
import '../theme.dart';

/// 消息流里的一张提问卡片（类似 ask_user_question）。
///
/// 以前「需要你拍板」是一段纯文本：「1. 弹窗时机？ A. 首次启动 B. 每次启动」，
/// 用户得在输入框里手打字母。问题一多就记不住第几个题对应哪个选项，
/// 打错一位 agent 就按错的选项往下做，往往要等几步之后才被发现。
/// 卡片把选择变成点选，提交时还能一次把勾选结果结构化发回去。
/// 一道题答到什么程度。
///
/// 草稿必须放在卡片外面：卡片在 ListView 里，滑出屏幕范围就被回收了，
/// 十五道题的表单很容易滑出去——草稿跟着 State 走就等于「回了半屏再看，
/// 刚才写的意见没了」。上层按消息序号持有一份，卡片重建也能接着填。
class AskDraft {
  final Set<String> picked = <String>{};
  String typed = '';
  bool get isEmpty => picked.isEmpty && typed.trim().isEmpty;
}

class AskCardView extends StatefulWidget {
  const AskCardView({
    super.key,
    required this.card,
    required this.canSubmit,
    required this.onSubmit,
    this.answered,
    this.busy = false,
    this.drafts,
  });

  final AskCard card;

  /// 上层持有的草稿，key 是题目 id；不传就退化成「只活在卡片里」
  final Map<String, AskDraft>? drafts;

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
  final Map<String, TextEditingController> _inputs = {};
  final Map<String, AskDraft> _local = {};
  bool _sending = false;
  String? _error;

  Map<String, AskDraft> get _drafts => widget.drafts ?? _local;

  AskDraft _draft(String qid) => _drafts.putIfAbsent(qid, AskDraft.new);

  @override
  void dispose() {
    for (final c in _inputs.values) {
      c.dispose();
    }
    super.dispose();
  }

  TextEditingController _input(String qid) => _inputs.putIfAbsent(
    qid,
    // 用草稿里的文字初始化：卡片被回收重建后，输入框里还是刚才写的内容
    () => TextEditingController(text: _draft(qid).typed),
  );

  bool get _locked => widget.answered != null;

  bool get _canSubmit {
    if (_locked || _sending || widget.busy || !widget.canSubmit) return false;
    // 只要求「至少答了一道」：agent 可能一次问十五个，硬性全答等于不让人提交，
    // 漏掉的那几道它下一轮还会再问
    for (final q in widget.card.questions) {
      if (!_draft(q.id).isEmpty) return true;
    }
    return false;
  }

  void _toggle(AskQuestion q, String optionId) {
    setState(() {
      final set = _draft(q.id).picked;
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

  /// 题干里已经自带编号（agent 常写成「Q14 是否需要…」「14. 是否…」）时不再加一次，
  /// 用户按卡片上看到的题号核对，序号必须和卡片一致。
  static final _numbered = RegExp(r'^\s*(?:[Qq第]\s*)?\d+');

  /// 提交后自动插进消息流的那句话。
  ///
  /// 用户要的是「打回就发打回，通过就发通过，决策就发问题+选项」——
  /// 群里其他人即使没看到卡片，也能从这句话知道刚才决定的是什么。
  String _summary() {
    final card = widget.card;
    if (card.isConfirm) {
      final q = card.questions.first;
      final d = _draft(q.id);
      final reason = d.typed.trim();
      if (d.picked.contains('approve')) return '通过';
      if (d.picked.contains('reject')) return reason.isEmpty ? '打回' : '打回：$reason';
      return reason;
    }
    final lines = <String>[];
    for (var i = 0; i < card.questions.length; i++) {
      final q = card.questions[i];
      final d = _draft(q.id);
      final typed = d.typed.trim();
      // 没答的题不进这句话：十五道里答了三道，群里只该出现三行
      if (d.picked.isEmpty && typed.isEmpty) continue;
      final labels = <String>[];
      for (var j = 0; j < q.options.length; j++) {
        if (d.picked.contains(q.options[j].id)) {
          labels.add('${String.fromCharCode(65 + j)}. ${q.options[j].label}');
        }
      }
      if (typed.isNotEmpty) {
        // 自己写的排最后一个选项的位置，和下发的选项字母对得上
        labels.add('${String.fromCharCode(65 + q.options.length)}. $typed');
      }
      // 题号用卡片上的序号，不是「答过的第几条」；只有一道题时卡片上就不带序号
      final numbered = card.questions.length > 1 && !_numbered.hasMatch(q.title);
      final head = numbered ? '${i + 1}. ${q.title}' : q.title;
      // 问题和选项分行：一行里塞「问题 A. 选项 B. 选项」读起来是一团，
      // 选项缩进两格，纯文本客户端（面板、引擎日志）也看得清层级
      lines.add(head);
      for (final label in labels) {
        lines.add('  $label');
      }
    }
    return lines.join('\n');
  }

  List<MessageAnswer> _answers() => [
    for (final q in widget.card.questions)
      // 没答的题不发：引擎那边按 qid 对位取选项，空答案只会让回答块变长
      if (!_draft(q.id).isEmpty)
        MessageAnswer(
          qid: q.id,
          optionIds: _draft(q.id).picked.toList(),
          input: _draft(q.id).typed.trim(),
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
              // 题干自带「Q14」这种编号时不再叠一层，否则卡片和自动回复里的题号都会变成「14. Q14 …」
              index: card.questions.length > 1 && !_numbered.hasMatch(card.questions[i].title)
                  ? i + 1
                  : null,
              question: card.questions[i],
              picked: _draft(card.questions[i].id).picked,
              input: _input(card.questions[i].id),
              enabled: !_locked && !_sending,
              onToggle: (id) => _toggle(card.questions[i], id),
              onTyped: (v) => _drafts
                  .putIfAbsent(card.questions[i].id, AskDraft.new)
                  .typed = v,
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
    required this.onTyped,
    required this.index,
    this.answered,
  });

  final AskQuestion question;
  final Set<String> picked;
  final TextEditingController input;
  final bool enabled;
  final void Function(String optionId) onToggle;
  final void Function(String text) onTyped;
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
              onChanged: onTyped,
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
