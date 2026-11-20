import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../api/models.dart';
import '../state/auth.dart';
import '../state/detail.dart';
import 'format.dart';
import 'theme.dart';
import 'widgets/stage.dart';

/// 需求详情：阶段进度 + 对话 + 拍板。
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
  final _scroll = ScrollController();

  @override
  void initState() {
    super.initState();
    _c.addListener(_onUpdate);
    _c.start();
  }

  @override
  void dispose() {
    _c.removeListener(_onUpdate);
    _c.dispose();
    _input.dispose();
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
    final ok = await _c.send(text);
    if (ok && mounted) _input.clear();
  }

  Future<void> _approve() async {
    final ok = await _c.approve();
    if (ok && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已通过')));
    }
  }

  /// 打回必须写原因：只说「不行」，agent 不知道该改什么，
  /// 下一轮大概率还是错的，白烧一轮 token。
  Future<void> _reject() async {
    final reason = await showDialog<String>(
      context: context,
      builder: (_) => const _RejectDialog(),
    );
    if (reason == null || reason.trim().isEmpty) return;
    final ok = await _c.reject(reason.trim());
    if (ok && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已打回')));
    }
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _c,
      builder: (context, _) {
        final t = _c.thread;
        return Scaffold(
          appBar: AppBar(
            title: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  t?.title ?? '需求',
                  style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                if (t != null)
                  Text(
                    [t.stage, t.stageStatus].where((e) => e != null && e.isNotEmpty).join(' · '),
                    style: TextStyle(
                      fontSize: 11,
                      fontWeight: FontWeight.w400,
                      color: Theme.of(context).colorScheme.onSurfaceVariant,
                    ),
                  ),
              ],
            ),
          ),
          body: Column(
            children: [
              if (t != null) _Header(thread: t),
              const Divider(height: 1),
              Expanded(child: _messageArea(context)),
              _composer(context),
            ],
          ),
        );
      },
    );
  }

  Widget _messageArea(BuildContext context) {
    if (_c.loading && _c.messages.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_c.error != null && _c.messages.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(28),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.cloud_off_outlined, color: Theme.of(context).colorScheme.error),
              const SizedBox(height: 12),
              Text(_c.error!, textAlign: TextAlign.center),
              const SizedBox(height: 16),
              OutlinedButton(onPressed: _c.refreshNow, child: const Text('重试')),
            ],
          ),
        ),
      );
    }
    if (_c.messages.isEmpty) {
      return Center(
        child: Text(
          '还没有对话',
          style: Theme.of(context).textTheme.bodySmall,
        ),
      );
    }

    // reverse: true 让新消息贴在底部，同时天然支持往上翻历史，
    // 不用自己算偏移量。所以列表要倒过来喂。
    final items = _c.messages.reversed.toList();
    return ListView.builder(
      controller: _scroll,
      reverse: true,
      padding: const EdgeInsets.fromLTRB(12, 12, 12, 12),
      itemCount: items.length,
      itemBuilder: (context, i) {
        final m = items[i];
        final older = i + 1 < items.length ? items[i + 1] : null;
        // 同一个人连续说话时不重复显示头像/时间，读起来更像对话
        final showMeta = older == null || older.role != m.role || m.at - older.at > 3 * 60 * 1000;
        return _Bubble(message: m, showMeta: showMeta, auth: widget.auth);
      },
    );
  }

  Widget _composer(BuildContext context) {
    final theme = Theme.of(context);
    final t = _c.thread;
    final busy = _c.sending;

    return SafeArea(
      top: false,
      child: Container(
        padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
        decoration: BoxDecoration(
          color: theme.colorScheme.surface,
          border: Border(
            top: BorderSide(color: theme.dividerColor.withValues(alpha: 0.5)),
          ),
        ),
        child: Column(
          children: [
            // 需要拍板时把动作放在输入框上方：这是当前最该做的事，
            // 藏在菜单里等于没有。
            if (_c.showActions) ...[
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton(
                      onPressed: busy ? null : _reject,
                      style: OutlinedButton.styleFrom(
                        foregroundColor: AppColors.blocked,
                        minimumSize: const Size(0, 42),
                      ),
                      child: const Text('打回'),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: FilledButton(
                      onPressed: busy ? null : _approve,
                      style: FilledButton.styleFrom(
                        backgroundColor: AppColors.done,
                        minimumSize: const Size(0, 42),
                      ),
                      child: const Text('通过'),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 8),
            ],
            // 普通成员能看到按钮但没有 canAct。这里不把按钮藏掉，
            // 而是真的让后端拒一次——用户明确要的就是这个行为：
            // 看得见、点得到、但会被告知「只有管理员能操作」。
            if (t != null && _c.canAct == false && (t.needsMe || t.blocked))
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Row(
                  children: [
                    Icon(
                      Icons.lock_outline,
                      size: 14,
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                    const SizedBox(width: 6),
                    Expanded(
                      child: Text(
                        '通过和打回只有系统管理员能操作',
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Expanded(
                  child: TextField(
                    controller: _input,
                    enabled: !busy,
                    minLines: 1,
                    maxLines: 5,
                    textInputAction: TextInputAction.newline,
                    decoration: const InputDecoration(
                      hintText: '说点什么…',
                      isDense: true,
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                IconButton.filled(
                  onPressed: busy ? null : _send,
                  icon: busy
                      ? const SizedBox(
                          width: 18,
                          height: 18,
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

/// 吸顶区：阶段进度 + 卡住原因。
class _Header extends StatelessWidget {
  const _Header({required this.thread});

  final Thread thread;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 6, 14, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          StageProgress(stages: thread.stages, currentLabel: thread.stage),
          if ((thread.waitingLabel ?? '').isNotEmpty) ...[
            const SizedBox(height: 8),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
              decoration: BoxDecoration(
                color: AppColors.waiting.withValues(alpha: 0.1),
                borderRadius: BorderRadius.circular(9),
              ),
              child: Text(
                thread.waitingLabel!,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: AppColors.waiting,
                  height: 1.45,
                ),
              ),
            ),
          ],
          if ((thread.featureBranch ?? '').isNotEmpty) ...[
            const SizedBox(height: 6),
            Row(
              children: [
                Icon(
                  Icons.account_tree_outlined,
                  size: 13,
                  color: theme.colorScheme.onSurfaceVariant,
                ),
                const SizedBox(width: 5),
                Expanded(
                  child: Text(
                    thread.featureBranch!,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                      fontSize: 11,
                    ),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}

/// 一条消息。
///
/// user 的消息靠右、用主题色；bot 的靠左、用中性色底。
/// bot 的消息通常很长（阶段报告、问题清单），所以宽度给到 88%，
/// 并且保留换行——压缩成两行会让人读不懂内容。
class _Bubble extends StatelessWidget {
  const _Bubble({required this.message, required this.showMeta, required this.auth});

  final Message message;
  final bool showMeta;
  final AuthController auth;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final mine = message.isMine;

    return Padding(
      padding: EdgeInsets.only(top: showMeta ? 12 : 3),
      child: Column(
        crossAxisAlignment: mine ? CrossAxisAlignment.end : CrossAxisAlignment.start,
        children: [
          if (showMeta)
            Padding(
              padding: const EdgeInsets.only(bottom: 4, left: 6, right: 6),
              child: Text(
                '${mine ? '我' : 'Agent'} · ${Fmt.messageTime(message.at)}',
                style: theme.textTheme.bodySmall?.copyWith(
                  fontSize: 10.5,
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ),
          ConstrainedBox(
            constraints: BoxConstraints(
              maxWidth: MediaQuery.sizeOf(context).width * 0.88,
            ),
            child: Container(
              padding: EdgeInsets.symmetric(
                horizontal: message.kind == 'image' ? 6 : 12,
                vertical: message.kind == 'image' ? 6 : 9,
              ),
              decoration: BoxDecoration(
                color: mine
                    ? theme.colorScheme.primaryContainer
                    : theme.colorScheme.surfaceContainerHighest.withValues(alpha: 0.65),
                borderRadius: BorderRadius.only(
                  topLeft: const Radius.circular(14),
                  topRight: const Radius.circular(14),
                  bottomLeft: Radius.circular(mine ? 14 : 4),
                  bottomRight: Radius.circular(mine ? 4 : 14),
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
        // 文本。SelectionArea 让长报告能长按复制——评审批次一屏看不完，
        // 想摘一段发出去是常态，不能丢。
        return SelectionArea(
          child: Text(
            message.text,
            style: const TextStyle(fontSize: 14, height: 1.5),
          ),
        );
    }
  }
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
          borderRadius: BorderRadius.circular(9),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxHeight: 320),
            child: Image.memory(snap.data!, fit: BoxFit.contain),
          ),
        );
      },
    );
  }

  Widget _fallback(BuildContext context, String text) {
    return SizedBox(
      width: 160,
      height: 90,
      child: Center(
        child: Text(text, style: Theme.of(context).textTheme.bodySmall),
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
      borderRadius: BorderRadius.circular(8),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 2),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.insert_drive_file_outlined, size: 20, color: theme.colorScheme.primary),
            const SizedBox(width: 8),
            Flexible(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    message.fileName ?? '文件',
                    style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w500),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  Text(
                    Fmt.bytes(message.fileSize),
                    style: theme.textTheme.bodySmall?.copyWith(fontSize: 11),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 6),
            Icon(Icons.download_outlined, size: 18, color: theme.colorScheme.onSurfaceVariant),
          ],
        ),
      ),
    );
  }
}

class _RejectDialog extends StatefulWidget {
  const _RejectDialog();

  @override
  State<_RejectDialog> createState() => _RejectDialogState();
}

class _RejectDialogState extends State<_RejectDialog> {
  final _text = TextEditingController();

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('打回'),
      content: TextField(
        controller: _text,
        autofocus: true,
        maxLines: 4,
        minLines: 2,
        decoration: const InputDecoration(
          hintText: '哪里不对、要改成什么样。写得越具体，下一轮改得越准。',
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('取消'),
        ),
        FilledButton(
          onPressed: () => Navigator.of(context).pop(_text.text),
          child: const Text('确认打回'),
        ),
      ],
    );
  }
}
