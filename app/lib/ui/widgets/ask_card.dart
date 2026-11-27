import 'package:flutter/material.dart';


import 'package:base/base.dart';
import 'package:network/network.dart';

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

/// 卡片在图里要保住的状态：当前看到第几题 + 每题的草稿。
///
/// 两样都不能跟着 State 走：卡片在 ListView 里滑出屏幕就被回收，
/// 看完第 3 题再滑回来如果退回第 1 题、意见也没了，等于白填。
class AskCardState {
  int step = 0;
  final Map<String, AskDraft> drafts = <String, AskDraft>{};
}

/// 题干里已经自带编号（agent 常写成「Q14 是否需要…」「14. 是否…」）时不再加一次，
/// 用户按卡片上看到的题号核对，序号必须和卡片一致。
/// 提问卡片和已回答卡片都要用，放文件级共享。
final _numberedTitle = RegExp(r'^\s*(?:[Qq第]\s*)?\d+');

/// 「我的回答」卡片：用户在提问卡片上提交后，自动发进群里的那条消息
/// 用这套 UI 展示——和提问卡片同一外壳，但一眼能区分：
/// 图标是对勾（提问是机器人），右侧挂「已回答」徽标，题目全部铺开、只读。
class AnsweredCardView extends StatelessWidget {
  const AnsweredCardView({super.key, required this.card, required this.answers});

  final AskCard card;
  final List<MessageAnswer> answers;

  MessageAnswer? _answerOf(String qid) {
    for (final a in answers) {
      if (a.qid == qid) return a;
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final numbered = card.questions.length > 1;

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(AppSpace.sm),
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
              Icon(Icons.task_alt, size: 16, color: scheme.primary),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  card.title,
                  style: AppText.caption.copyWith(
                    color: scheme.primary,
                    fontWeight: FontWeight.w600,
                  ),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              // 状态徽标：光靠对勾图标不够——「已回答」三个字把
              // 「这是结果回显」说死，不会和还没作答的卡片搞混。
              Text(
                '已回答',
                style: AppText.caption.copyWith(
                  color: AppColors.done(context),
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          for (var i = 0; i < card.questions.length; i++) ...[
            if (i > 0) const SizedBox(height: AppSpace.xs),
            _AnsweredQuestion(
              index: numbered && !_numberedTitle.hasMatch(card.questions[i].title) ? i + 1 : null,
              question: card.questions[i],
              answer: _answerOf(card.questions[i].id),
            ),
          ],
        ],
      ),
    );
  }
}

/// 已回答卡片里的一道题：只展示用户选中的选项，不铺完整选项列表——
/// 这条消息是「结果回显」，不是让人再核对一遍全选项；没选中的项
/// 置灰排一片反而让人怀疑自己是不是漏选了。
class _AnsweredQuestion extends StatelessWidget {
  const _AnsweredQuestion({required this.question, required this.answer, required this.index});

  final AskQuestion question;
  final MessageAnswer? answer;
  final int? index;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final picked = answer?.optionIds ?? const <String>[];
    final typed = answer?.input.trim() ?? '';
    // 选项按卡片上的顺序列，只留选中的；选项 id 可能和卡片对不上
    // （老数据 / 引擎改过选项），找不到就按选择顺序兜底
    final chosen = <String>[];
    for (final o in question.options) {
      if (picked.contains(o.id)) chosen.add(o.label);
    }
    for (final id in picked) {
      if (!question.options.any((o) => o.id == id)) chosen.add(id);
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          index == null ? question.title : '$index. ${question.title}',
          style: AppText.bodyS.copyWith(fontSize: 15, height: 1.3, fontWeight: FontWeight.w600),
        ),
        const SizedBox(height: 6),
        if (chosen.isEmpty && typed.isEmpty)
          Text(
            '（未作答）',
            style: AppText.bodyS.copyWith(color: scheme.onSurfaceVariant),
          )
        else ...[
          for (final label in chosen)
            Padding(
              padding: const EdgeInsets.only(bottom: AppSpace.xxs),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(Icons.check, size: 18, color: scheme.primary),
                  const SizedBox(width: AppSpace.xs),
                  Expanded(
                    child: Text(
                      label,
                      style: AppText.bodyS.copyWith(fontWeight: FontWeight.w600),
                    ),
                  ),
                ],
              ),
            ),
          if (typed.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: AppSpace.xxs),
              child: Text(
                '补充：$typed',
                style: AppText.bodyS.copyWith(color: scheme.onSurfaceVariant),
              ),
            ),
        ],
      ],
    );
  }
}

class AskCardView extends StatefulWidget {
  const AskCardView({
    super.key,
    required this.card,
    required this.canSubmit,
    required this.onSubmit,
    this.answered,
    this.busy = false,
    this.state,
  });

  final AskCard card;

  /// 上层持有的状态；不传就退化成「只活在卡片里」
  final AskCardState? state;

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
  final AskCardState _local = AskCardState();
  bool _sending = false;
  String? _error;

  AskCardState get _st => widget.state ?? _local;

  Map<String, AskDraft> get _drafts => _st.drafts;

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
    // 每道题都必须答（选了选项或自己输入了文字）才能提交。
    // 之前只要求「至少答一道」——Q1 漏答跟着提交出去了，agent 少一条
    // 关键拍板只能靠猜，下一轮还得再问一遍。
    for (final q in widget.card.questions) {
      if (_draft(q.id).isEmpty) return false;
    }
    return true;
  }

  void _toggle(AskQuestion q, String optionId) {
    var pickedNow = false;
    setState(() {
      final set = _draft(q.id).picked;
      if (q.isMulti) {
        set.contains(optionId) ? set.remove(optionId) : set.add(optionId);
      } else {
        // 单选：再点一次取消，方便「我选错了，清掉」
        if (set.contains(optionId)) {
          set.clear();
        } else {
          set
            ..clear()
            ..add(optionId);
          pickedNow = true;
        }
      }
      _error = null;
    });
    // 单选点完就往下走：一次只看一道题，选中还停在原地等于让人多点一次「下一题」。
    // 多选不能自动走——第二项还没点完，跳走就等于把它从眼前拿掉。
    if (pickedNow) _next(q.id);
  }

  List<AskQuestion> get _questions => widget.card.questions;

  /// 翻到某一题（越界就夹在范围内）。
  void _go(int step) {
    final last = _questions.length - 1;
    setState(() => _st.step = step < 0 ? 0 : (step > last ? last : step));
  }

  /// 单选作答后自动前进一位；已经是最后一题就不动。
  void _next(String qid) {
    final i = _questions.indexWhere((q) => q.id == qid);
    if (i >= 0 && i < _questions.length - 1) _go(i + 1);
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
    final total = _questions.length;
    final step = _st.step.clamp(0, total - 1);
    final q = _questions[step];
    final isLast = step == total - 1;
    final submitted = _locked;

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(AppSpace.sm),
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
              Icon(Icons.smart_toy_outlined, size: 16, color: scheme.primary),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  card.title,
                  style: AppText.caption.copyWith(
                    color: scheme.primary,
                    fontWeight: FontWeight.w600,
                  ),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          // 一次只显示一道题：agent 一次能问十五道，全铺开是一屏表单，
          // 填到一半根本不知道还剩几道、自己在第几道。
          _Question(
            // 题干自带「Q14」这种编号时不再叠一层，否则卡片和自动回复里的题号都会变成「14. Q14 …」
            index: total > 1 && !_numbered.hasMatch(q.title) ? step + 1 : null,
            question: q,
            picked: _draft(q.id).picked,
            input: _input(q.id),
            enabled: !submitted && !_sending,
            onToggle: (id) => _toggle(q, id),
            onTyped: (v) => _drafts.putIfAbsent(q.id, AskDraft.new).typed = v,
            answered: answered,
          ),
          if (_error != null) ...[
            const SizedBox(height: AppSpace.xs),
            Text(_error!, style: AppText.bodyS.copyWith(color: scheme.error)),
          ],
          const SizedBox(height: AppSpace.xs),
          Row(
            children: [
              // 「< 1/3 >」：检查前面的答案、临时改主意都靠它
              if (total > 1) ...[
                _StepArrow(
                  icon: Icons.chevron_left,
                  tooltip: '上一题',
                  onTap: step > 0 ? () => _go(step - 1) : null,
                ),
                Text(
                  '${step + 1}/$total',
                  style: AppText.caption.copyWith(
                    color: scheme.onSurfaceVariant,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                _StepArrow(
                  icon: Icons.chevron_right,
                  tooltip: '下一题',
                  onTap: !isLast ? () => _go(step + 1) : null,
                ),
              ],
              const Spacer(),
              if (submitted)
                Text(
                  '已提交',
                  style: AppText.caption.copyWith(color: scheme.onSurfaceVariant),
                )
              else if (!widget.canSubmit)
                Text(
                  '通过和打回只有系统管理员能操作',
                  style: AppText.caption.copyWith(color: scheme.onSurfaceVariant),
                )
              else ...[
                // 跳过 = 先翻过去，回头还得答；没答完前提交一直是灰的
                if (!isLast)
                  TextButton(
                    onPressed: _sending ? null : () => _go(step + 1),
                    style: TextButton.styleFrom(
                      minimumSize: const Size(0, 40),
                      padding: const EdgeInsets.symmetric(horizontal: AppSpace.sm),
                    ),
                    child: const Text('跳过'),
                  ),
                FilledButton(
                  // 只有站在最后一题上才有意义：前一题点提交，后面那些题还没看
                  onPressed: isLast && _canSubmit ? _submit : null,
                  style: FilledButton.styleFrom(
                    minimumSize: const Size(0, 40),
                    padding: const EdgeInsets.symmetric(horizontal: AppSpace.lg),
                  ),
                  child: _sending
                      ? const SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : Text(card.submitLabel),
                ),
              ],
            ],
          ),
        ],
      ),
    );
  }
}

/// 「上一题 / 下一题」的小箭头：站点在卡片底部，尺寸收在 32 上下，
/// 但整块都能点，不影响命中。
class _StepArrow extends StatelessWidget {
  const _StepArrow({required this.icon, required this.tooltip, this.onTap});

  final IconData icon;
  final String tooltip;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return IconButton(
      onPressed: onTap,
      tooltip: tooltip,
      icon: Icon(icon, size: 20),
      visualDensity: VisualDensity.compact,
      padding: EdgeInsets.zero,
      constraints: const BoxConstraints(minWidth: 32, minHeight: 32),
      color: Theme.of(context).colorScheme.onSurfaceVariant,
      disabledColor: Theme.of(context).colorScheme.onSurfaceVariant.withValues(alpha: 0.35),
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
          style: AppText.bodyS.copyWith(fontSize: 15, height: 1.3, fontWeight: FontWeight.w600),
        ),
        const SizedBox(height: 6),
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
              decoration: InputDecoration(
                hintText: question.inputLabel,
                isDense: true,
                // 卡片里一屏要塞好几道题，输入框按表单默认的 12/16 内边距会
                // 把整张卡撑得很长，这里收到 8/12
                contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              ),
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
        padding: const EdgeInsets.symmetric(vertical: 6),
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
