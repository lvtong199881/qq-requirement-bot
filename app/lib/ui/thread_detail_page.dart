import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../api/models.dart';
import '../state/auth.dart';
import '../state/detail.dart';
import 'format.dart';
import 'theme.dart';
import 'widgets/ask_card.dart';

/// 群详情：阶段进度 + 对话 + 拍板。
///
/// 群是容器，需求是群里跑的那条 flow。同一个群先当聊天用，@ 一下需求 bot
/// 才开始跑需求。所以这个页面有两种形态：
/// 1. 群还是聊天模式（mode == chat）：只有输入框，提示怎么把 agent 叫起来；
/// 2. 需求在跑：阶段条 + 消息流 + 需要拍板时的「通过 / 打回」。
///
/// 页面结构自上而下三段：
/// 1. 吸顶的阶段条——随时知道走到哪了，滚到下面也不用往回找；
/// 2. 消息流——和 agent 的完整对话，长文本按气泡换行；
/// 3. 底部输入区——平时是输入框，需要拍板时换成「通过 / 打回」。
class ThreadDetailPage extends StatefulWidget {
  const ThreadDetailPage({
    super.key,
    required this.auth,
    required this.threadId,
    this.seed,
  });

  final AuthController auth;
  final String threadId;
  final Thread? seed;

  @override
  State<ThreadDetailPage> createState() => _ThreadDetailPageState();
}

class _ThreadDetailPageState extends State<ThreadDetailPage> {
  late final ThreadDetailController _c = ThreadDetailController(
    auth: widget.auth,
    threadId: widget.threadId,
    seed: widget.seed,
  );
  final _input = TextEditingController();
  final _focus = FocusNode();
  final _scroll = ScrollController();

  /// 每张提问卡片的临时状态（看到第几题 + 每题草稿），key 是卡片消息的 seq。
  /// 放在页面这一层：卡片在 ListView 里滑出屏幕就被回收，状态跟着 State 走就丢了。
  final Map<int, AskCardState> _cardStates = {};

  /// 首屏加载超过 1 秒才出转圈，避免网络快时闪一下。
  bool _slowLoad = false;
  Timer? _slowTimer;

  @override
  void initState() {
    super.initState();
    _c.addListener(_onUpdate);
    _c.start();
    _slowTimer = Timer(const Duration(seconds: 1), () {
      if (mounted && _c.loading) setState(() => _slowLoad = true);
    });
  }

  @override
  void dispose() {
    _slowTimer?.cancel();
    _c.removeListener(_onUpdate);
    _c.dispose();
    _input.dispose();
    _focus.dispose();
    _scroll.dispose();
    super.dispose();
  }

  /// 新消息进来后滚到底；同时把操作失败的提示弹出来。
  void _onUpdate() {
    final err = _c.actionError;
    if (err != null && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(err)));
      _c.clearActionError();
    }
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_scroll.hasClients) return;
      // 只在已经接近底部时才自动跟随。用户往上翻历史时强行拽回去
      // 是最招人烦的交互之一。
      final pos = _scroll.position;
      if (pos.maxScrollExtent - pos.pixels > 220) return;
      _scroll.jumpTo(pos.maxScrollExtent);
    });
  }

  Future<void> _send() async {
    final text = _input.text;
    if (text.trim().isEmpty) return;
    // @ 了需求 bot 的这句才是「开需求」，服务端也从文本里认，
    // 但显式带上更准：bot 名字是可配置的，文本里不一定是「需求bot」
    final mentions = text.contains('@需求bot') ? const ['bot'] : const <String>[];
    final ok = await _c.send(text, mentions: mentions);
    if (ok && mounted) _input.clear();
  }

  /// 把「@需求bot 」填进输入框。
  ///
  /// 不直接发一条空需求：用户往往要先说一句背景（给谁看、什么时候弹），
  /// 让他接着打比替他按下发送键更符合实际用法。
  void _mentionBot() {
    const token = '@需求bot ';
    if (_input.text.contains('@需求bot')) {
      _focus.requestFocus();
      return;
    }
    final head = _input.text;
    _input.text = head.isEmpty || head.endsWith(' ') ? '$head$token' : '$head $token';
    _input.selection = TextSelection.collapsed(offset: _input.text.length);
    _focus.requestFocus();
  }

  // 通过/打回不再走这里：它们已经是消息流里的提问卡片，提交时和普通消息
  // 走同一条路径（带 answers），权限也由后端按 confirm 判。

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _c,
      builder: (context, _) {
        final t = _c.thread;
        final theme = Theme.of(context);
        return Scaffold(
          appBar: AppBar(
            // 标题只留群名/需求名。阶段和状态挪到下面那排 tag 里——标题栏第二行
            // 和下面的阶段信息说的是同一件事，两处重复等于把一屏切成三块。
            toolbarHeight: 48,
            title: Text(
              t?.title ?? '群',
              style: AppText.titleS.copyWith(color: theme.colorScheme.onSurface),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ),
          body: Column(
            // 撑满整宽，否则只有 tag 的吸顶区会被 Column 居中，看着像缩进了一截
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (t != null) _Header(thread: t),
              if (t != null) const Divider(),
              Expanded(child: _messageArea(context)),
              _composer(context),
            ],
          ),
        );
      },
    );
  }

  Widget _messageArea(BuildContext context) {
    final theme = Theme.of(context);
    if (_c.loading && _c.messages.isEmpty) {
      return _slowLoad
          ? const Center(child: CircularProgressIndicator())
          : const SizedBox.shrink();
    }
    if (_c.error != null && _c.messages.isEmpty) {
      return Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(AppSpace.xxl),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.cloud_off_outlined, size: 48, color: theme.colorScheme.error),
              const SizedBox(height: AppSpace.md),
              Text('拉不到对话', style: AppText.titleM.copyWith(color: theme.colorScheme.onSurface)),
              const SizedBox(height: AppSpace.xs),
              Text(
                _c.error!,
                textAlign: TextAlign.center,
                style: AppText.bodyS.copyWith(color: theme.colorScheme.onSurfaceVariant),
              ),
              const SizedBox(height: AppSpace.xl),
              OutlinedButton(onPressed: _c.refreshNow, child: const Text('重试')),
            ],
          ),
        ),
      );
    }
    if (_c.messages.isEmpty) {
      // 一句都没有的群：不是「没有对话」，而是「等你开口」。
      // 已经跑过需求的群再说「说第一句话」就不对了，所以分开。
      final t = _c.thread;
      final empty = (t?.mode ?? 'chat') == 'chat'
          ? (t?.pending == true
              ? '群建好了。想聊天就直接说，要干活就 @需求bot 说一句。'
              : '群里还没有消息，说第一句吧。')
          : '群里还没有消息。要它动手，就 @需求bot 说一句。';
      return Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(AppSpace.xxl),
          child: Text(
            empty,
            textAlign: TextAlign.center,
            style: AppText.bodyS.copyWith(color: theme.colorScheme.onSurfaceVariant),
          ),
        ),
      );
    }

    // reverse: true 让新消息贴在底部，同时天然支持往上翻历史，
    // 不用自己算偏移量。所以列表要倒过来喂。
    final items = _c.messages.reversed.toList();
    // 谁回答了哪张卡片：用户消息上的 askSeq 指向卡片消息的 seq。
    // 卡片拿到这个就不再让人重复提交，直接显示勾过的结果。
    final answers = <int, List<MessageAnswer>>{};
    final cards = <int, AskCard>{};
    for (final m in _c.messages) {
      final seq = m.askSeq;
      if (seq != null && m.answers.isNotEmpty) answers[seq] = m.answers;
      final asked = m.ask;
      if (asked != null) cards[m.seq] = asked;
    }
    return ListView.builder(
      controller: _scroll,
      reverse: true,
      padding: const EdgeInsets.symmetric(
        horizontal: AppInset.page,
        vertical: AppSpace.sm,
      ),
      itemCount: items.length,
      itemBuilder: (context, i) {
        final m = items[i];
        final older = i + 1 < items.length ? items[i + 1] : null;
        // 同一个人连续说话时不重复显示头像/时间，读起来更像对话
        final showMeta = older == null || older.role != m.role || m.at - older.at > 3 * 60 * 1000;
        final card = m.ask;
        if (card != null) {
          // 卡片和气泡是两条消息，头顶必须留出间隔：贴在一起会让人以为
          // 「Agent 那句话 + 这张卡片」是同一条消息里的两截圆角。
          return Padding(
            padding: const EdgeInsets.only(top: AppSpace.sm),
            child: AskCardView(
              // 带上消息序号：列表增删消息时 Flutter 才会把同一个状态还给同一张卡
              key: ValueKey('ask-${m.seq}'),
              card: card,
              state: _cardStates.putIfAbsent(m.seq, AskCardState.new),
              canSubmit: widget.auth.perms.confirm,
              answered: answers[m.seq],
              busy: _c.sending,
              onSubmit: (text, list) => _c.send(text, answers: list, askSeq: m.seq),
            ),
          );
        }
        return _Bubble(
          message: m,
          showMeta: showMeta,
          auth: widget.auth,
          // 回答了卡片的消息：气泡按「问题一行、选项缩进一行」排，
          // 一行到底的话十五道题糊成一片，看不清哪个答案属于哪一问
          answeredCard: m.askSeq == null ? null : cards[m.askSeq],
        );
      },
    );
  }

  Widget _composer(BuildContext context) {
    final theme = Theme.of(context);
    final t = _c.thread;
    final busy = _c.sending;
    // 群还是聊天模式：谁都能聊，只有管理员能把 agent 叫起来（@ 需求 bot）。
    // 所以输入框永远可用，锁只锁在「叫 agent」这一步上。
    final isChat = (t?.mode ?? 'chat') == 'chat';
    final canStart = widget.auth.perms.startRequirement;

    return SafeArea(
      top: false,
      child: Container(
        padding: const EdgeInsets.fromLTRB(
          AppInset.page,
          AppSpace.xs,
          AppInset.page,
          AppSpace.xs,
        ),
        decoration: BoxDecoration(
          color: theme.colorScheme.surface,
          border: Border(top: BorderSide(color: theme.dividerColor)),
        ),
        child: Column(
          children: [
            // 只剩一个「@需求bot」标签：聊天本身不需要解释，需要解释的是
            // 「怎么让它动手」——所以标签就是入口，点一下把「@需求bot 」填进输入框。
            // 没权限时标签变灰带锁，点不动但还在，用户看得到「还能这样」。
            Align(
              alignment: Alignment.centerLeft,
              child: Padding(
                padding: const EdgeInsets.only(bottom: AppSpace.xs),
                child: Tooltip(
                  message: canStart || !isChat ? '点一下，把「@需求bot」填进输入框' : '要让 agent 动手，得找管理员',
                  child: InkWell(
                    onTap: (canStart || !isChat) && !busy ? _mentionBot : null,
                    borderRadius: BorderRadius.circular(AppRadius.pill),
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                      decoration: BoxDecoration(
                        color: canStart || !isChat
                            ? theme.colorScheme.primaryContainer
                            : theme.colorScheme.surfaceContainerHighest,
                        borderRadius: BorderRadius.circular(AppRadius.pill),
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(
                            canStart || !isChat ? Icons.smart_toy_outlined : Icons.lock_outline,
                            size: 14,
                            color: canStart || !isChat
                                ? theme.colorScheme.primary
                                : theme.colorScheme.onSurfaceVariant,
                          ),
                          const SizedBox(width: 4),
                          Text(
                            '@需求bot',
                            style: AppText.caption.copyWith(
                              fontSize: 12,
                              fontWeight: FontWeight.w600,
                              color: canStart || !isChat
                                  ? theme.colorScheme.primary
                                  : theme.colorScheme.onSurfaceVariant,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
            ),
            Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Expanded(
                  child: TextField(
                    controller: _input,
                    focusNode: _focus,
                    enabled: !busy,
                    minLines: 1,
                    maxLines: 5,
                    style: AppText.body.copyWith(color: theme.colorScheme.onSurface),
                    textInputAction: TextInputAction.newline,
                    decoration: InputDecoration(
                      hintText: isChat ? '聊点什么' : '聊点什么（要它听就 @需求bot）',
                    ),
                  ),
                ),
                const SizedBox(width: AppSpace.xs),
                IconButton.filled(
                  tooltip: '发送',
                  onPressed: busy ? null : _send,
                  icon: busy
                      ? const SizedBox(
                          width: 20,
                          height: 20,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.arrow_upward),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// 吸顶区：一行 tag（阶段 / 状态 / 分支）。
///
/// 原来这里是「阶段进度条 + 一整行等待原因」，两行内容把消息区压掉一块，
/// 而且和标题栏第二行重复。现在只留 tag：阶段名一个、状态一个（卡住原因
/// 点开看），分支一个。
class _Header extends StatelessWidget {
  const _Header({required this.thread});

  final Thread thread;

  /// 状态 tag 的文案。顺序即优先级：卡住 > 已完成 > 待决策 > 进行中。
  String? get _statusLabel {
    if (thread.blocked) return '卡住';
    if (thread.finished) return '已完成';
    if (thread.needsMe) return '待决策';
    if (thread.running) return '进行中';
    if ((thread.waitingLabel ?? '').isNotEmpty) return '等你确认';
    return null;
  }

  @override
  Widget build(BuildContext context) {
    final isChat = thread.mode == 'chat' && thread.name?.isNotEmpty != true;
    final stage = (thread.stage ?? '').isNotEmpty
        ? thread.stage!
        : (isChat ? '群聊' : '待提需求');
    final status = _statusLabel;
    final reason = thread.waitingLabel ?? '';

    return Padding(
      padding: const EdgeInsets.fromLTRB(
        AppInset.page,
        AppSpace.xs,
        AppInset.page,
        AppSpace.xs,
      ),
      child: Wrap(
        spacing: AppSpace.xs,
        runSpacing: AppSpace.xs,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          _Tag(
            label: stage,
            tint: AppColors.running(context),
            icon: Icons.donut_small_outlined,
          ),
          if (status != null)
            _Tag(
              label: status,
              tint: thread.blocked ? AppColors.blocked(context) : AppColors.waiting(context),
              icon: thread.blocked ? Icons.error_outline : Icons.schedule,
              // 原因可能很长（连错三轮那种），塞进 tag 会把整行撑成两行
              onTap: reason.isEmpty
                  ? null
                  : () => showDialog<void>(
                      context: context,
                      builder: (ctx) => AlertDialog(
                        title: Text(status),
                        content: SingleChildScrollView(
                          child: SelectableText(
                            reason,
                            style: AppText.bodyS.copyWith(
                              color: Theme.of(ctx).colorScheme.onSurfaceVariant,
                            ),
                          ),
                        ),
                        actions: [
                          TextButton(onPressed: () => Navigator.of(ctx).pop(), child: const Text('知道了')),
                        ],
                      ),
                    ),
            ),
        ],
      ),
    );
  }
}

/// 小标签：圆角胶囊，12% 底色的同色文字。
class _Tag extends StatelessWidget {
  const _Tag({
    required this.label,
    required this.tint,
    required this.icon,
    this.onTap,
  });

  final String label;
  final Color tint;
  final IconData icon;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final body = Container(
      padding: const EdgeInsets.symmetric(horizontal: AppSpace.xs, vertical: 2),
      decoration: BoxDecoration(
        color: tint.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(AppRadius.pill),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 12, color: tint),
          const SizedBox(width: 4),
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 160),
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: AppText.caption.copyWith(
                color: tint,
                fontWeight: FontWeight.w600,
                fontSize: 12,
              ),
            ),
          ),
        ],
      ),
    );
    if (onTap == null) return body;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(AppRadius.pill),
      child: body,
    );
  }
}

/// 一条消息。
///
/// user 的消息靠右、用主题色；bot 的靠左、用中性色底。
/// bot 的消息通常很长（阶段报告、问题清单），所以宽度给到 88%，
/// 并且保留换行——压缩成两行会让人读不懂内容。
class _Bubble extends StatelessWidget {
  const _Bubble({
    required this.message,
    required this.showMeta,
    required this.auth,
    this.answeredCard,
  });

  final Message message;
  final bool showMeta;
  final AuthController auth;

  /// 这条消息是在回答哪张卡片；有值且答了题时，正文按结构化排版
  final AskCard? answeredCard;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final mine = message.isMineFor(auth.user?.id);
    // 群里可能有好几个人，光写「我 / Agent」会让人分不清这句是谁说的
    final who = mine
        ? '我'
        : message.role == 'bot'
        ? 'Agent'
        : (message.nickname?.isNotEmpty == true ? message.nickname! : '成员');

    return Padding(
      padding: EdgeInsets.only(top: showMeta ? AppSpace.sm : AppSpace.xxs),
      child: Column(
        crossAxisAlignment: mine ? CrossAxisAlignment.end : CrossAxisAlignment.start,
        children: [
          if (showMeta)
            Padding(
              padding: const EdgeInsets.only(bottom: AppSpace.xxs, left: AppSpace.xs, right: AppSpace.xs),
              child: Text(
                '$who · ${Fmt.messageTime(message.at)}',
                style: AppText.caption.copyWith(color: theme.colorScheme.onSurfaceVariant),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ConstrainedBox(
            constraints: BoxConstraints(
              maxWidth: MediaQuery.sizeOf(context).width * 0.88,
            ),
            child: Container(
              padding: EdgeInsets.symmetric(
                horizontal: message.kind == 'image' ? AppSpace.xs : AppSpace.sm,
                vertical: message.kind == 'image' ? AppSpace.xs : AppSpace.xs,
              ),
              decoration: BoxDecoration(
                color: mine
                    ? theme.colorScheme.primaryContainer
                    : theme.colorScheme.surfaceContainerHighest.withValues(alpha: 0.65),
                borderRadius: BorderRadius.only(
                  topLeft: const Radius.circular(AppRadius.medium),
                  topRight: const Radius.circular(AppRadius.medium),
                  bottomLeft: const Radius.circular(AppRadius.medium),
                  bottomRight: const Radius.circular(AppRadius.medium),
                ),
              ),
              child: _content(context),
            ),
          ),
        ],
      ),
    );
  }

  Widget _content(BuildContext context) {
    switch (message.kind) {
      case 'image':
        return _ImageContent(message: message, auth: auth);
      case 'file':
        return _FileContent(message: message, auth: auth);
      default:
        final card = answeredCard;
        if (card != null && !card.isConfirm && message.answers.isNotEmpty) {
          return _AnswerLines(card: card, answers: message.answers);
        }
        // 文本。SelectionArea 让长报告能长按复制——评审批次一屏看不完，
        // 想摘一段发出去是常态，不能丢。
        return SelectionArea(
          child: Text(
            message.text,
            style: AppText.body.copyWith(
              color: Theme.of(context).colorScheme.onSurface,
            ),
          ),
        );
    }
  }
}

/// 卡片答案的排版：问题一行，勾选的选项各占一行并缩进。
///
/// 以前是一条消息里连排「问题 A. 选项 B. 选项」，问题一多就像一坨正文，
/// 看不出哪句是问、哪句是答。选项用更小更淡的字，层级一眼分得开。
class _AnswerLines extends StatelessWidget {
  const _AnswerLines({required this.card, required this.answers});

  final AskCard card;
  final List<MessageAnswer> answers;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final rows = <Widget>[];
    for (final a in answers) {
      AskQuestion? q;
      for (final candidate in card.questions) {
        if (candidate.id == a.qid) {
          q = candidate;
          break;
        }
      }
      final title = q?.title ?? a.qid;
      final labels = <String>[];
      if (q != null) {
        for (final id in a.optionIds) {
          final i = q.options.indexWhere((o) => o.id == id);
          if (i >= 0) {
            labels.add('${String.fromCharCode(65 + i)}. ${q.options[i].label}');
          }
        }
        final typed = a.input.trim();
        if (typed.isNotEmpty) {
          // 自写内容排在最后一个选项的位置，和卡片上简化出来的字母一致
          labels.add('${String.fromCharCode(65 + q.options.length)}. $typed');
        }
      }
      if (labels.isEmpty) continue;
      if (rows.isNotEmpty) rows.add(const SizedBox(height: AppSpace.sm));
      rows.add(
        Text(
          title,
          style: AppText.body.copyWith(color: scheme.onSurface, fontWeight: FontWeight.w600),
        ),
      );
      for (final label in labels) {
        rows.add(
          Padding(
            padding: const EdgeInsets.only(top: AppSpace.xxs, left: AppSpace.md),
            child: Text(
              label,
              style: AppText.bodyS.copyWith(color: scheme.onSurfaceVariant),
            ),
          ),
        );
      }
    }
    if (rows.isEmpty) {
      return Text(messageFallbackText(answers), style: AppText.body);
    }
    return SelectionArea(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: rows),
    );
  }

  /// 卡片已经不在了（比如拉取范围截断）时的兜底：只列选项字母
  static String messageFallbackText(List<MessageAnswer> answers) =>
      answers.map((a) => a.optionIds.join('、')).where((s) => s.isNotEmpty).join(' ');
}

class _ImageContent extends StatefulWidget {
  const _ImageContent({required this.message, required this.auth});

  final Message message;
  final AuthController auth;

  @override
  State<_ImageContent> createState() => _ImageContentState();
}

/// 图片走带 Authorization 头的请求自己取字节，不能直接用
/// Image.network——它没法带自定义 header，会 401。
class _ImageContentState extends State<_ImageContent> {
  late Future<Uint8List?> _future;

  @override
  void initState() {
    super.initState();
    _future = _load();
  }

  Future<Uint8List?> _load() async {
    final url = widget.message.artifactUrl;
    if (url == null) return null;
    final bytes = await widget.auth.client.artifactBytes(url);
    return Uint8List.fromList(bytes);
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<Uint8List?>(
      future: _future,
      builder: (context, snap) {
        if (snap.hasError) {
          return _fallback(context, '图片加载失败');
        }
        if (!snap.hasData || snap.data == null) {
          return _fallback(context, '加载中…');
        }
        return ClipRRect(
          borderRadius: BorderRadius.circular(AppRadius.medium),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxHeight: 320),
            child: Image.memory(snap.data!, fit: BoxFit.contain),
          ),
        );
      },
    );
  }

  Widget _fallback(BuildContext context, String text) {
    final theme = Theme.of(context);
    return Container(
      constraints: const BoxConstraints(maxWidth: 200),
      padding: const EdgeInsets.symmetric(horizontal: AppSpace.md, vertical: AppSpace.xl),
      color: theme.colorScheme.surfaceContainerHighest,
      child: Text(
        text,
        textAlign: TextAlign.center,
        style: AppText.bodyS.copyWith(color: theme.colorScheme.onSurfaceVariant),
      ),
    );
  }
}

class _FileContent extends StatelessWidget {
  const _FileContent({required this.message, required this.auth});

  final Message message;
  final AuthController auth;

  Future<void> _download(BuildContext context) async {
    final url = message.artifactUrl;
    if (url == null) return;
    final messenger = ScaffoldMessenger.of(context);
    try {
      final bytes = await auth.client.artifactBytes(url);
      final name = message.fileName ?? 'artifact.bin';

      // 不引 share_plus / path_provider：两者都只为了「把字节落地」，
      // 而 systemTemp 在所有平台上都是本 App 可写的临时目录。
      // 落地后把路径复制到剪贴板，用户自己去文件 App 里找——
      // 团队内部场景这点摩擦可以接受，换掉两个插件的原生配置成本。
      final file = File('${Directory.systemTemp.path}/$name');
      await file.writeAsBytes(bytes, flush: true);

      await Clipboard.setData(ClipboardData(text: file.path));
      messenger.showSnackBar(
        SnackBar(content: Text('已保存到 ${file.path}（路径已复制）')),
      );
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text('下载失败：$e')));
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return InkWell(
      onTap: () => _download(context),
      borderRadius: BorderRadius.circular(AppRadius.medium),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: AppSpace.xxs, vertical: AppSpace.xxs),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.insert_drive_file_outlined, size: 20, color: theme.colorScheme.primary),
            const SizedBox(width: AppSpace.xs),
            Flexible(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    message.fileName ?? '文件',
                    style: AppText.bodyS.copyWith(
                      color: theme.colorScheme.onSurface,
                      fontWeight: FontWeight.w500,
                    ),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  Text(
                    Fmt.bytes(message.fileSize),
                    style: AppText.caption.copyWith(color: theme.colorScheme.onSurfaceVariant),
                  ),
                ],
              ),
            ),
            const SizedBox(width: AppSpace.xs),
            Icon(Icons.download_outlined, size: 20, color: theme.colorScheme.onSurfaceVariant),
          ],
        ),
      ),
    );
  }
}

