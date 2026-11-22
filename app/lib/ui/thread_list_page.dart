import 'dart:async';

import 'package:flutter/material.dart';

import '../api/client.dart';
import '../api/models.dart';
import '../state/auth.dart';
import '../state/threads.dart';
import 'scan_page.dart';
import 'theme.dart';
import 'thread_detail_page.dart';
import 'widgets/avatar.dart';
import 'widgets/toast.dart';

/// 群列表。
///
/// 流程是「先建群，再在群里走需求」：群是容器，需求是群里跑的那条 flow。
/// 所以这一页的主语是群——建群时只起个名字，真正要做什么等进群之后说。
///
/// 布局取向：一行一个群，像 IM 的会话列表——头像（右上角挂未读红点）、
/// 群名、最后一条消息，全部单行省略。阶段、状态、待办理由这些细节都
/// 留给群详情页去讲：列表只回答「哪个群有新东西」。
///
/// 建群入口不放在这一页的浮动按钮上：底部导航已经占了一条，
/// 再叠一个 FAB 会挡住列表最后一行。放 AppBar 的 + 上，位置稳定又不抢戏。
class ThreadListPage extends StatefulWidget {
  const ThreadListPage({super.key, required this.auth, required this.controller});

  final AuthController auth;
  final ThreadListController controller;

  @override
  State<ThreadListPage> createState() => _ThreadListPageState();
}

class _ThreadListPageState extends State<ThreadListPage> {
  /// 首屏加载超过 1 秒才出转圈：网络快的时候闪一下转圈比什么都不显示更晃眼。
  bool _slowLoad = false;
  Timer? _slowTimer;

  @override
  void initState() {
    super.initState();
    widget.controller.start();
    _slowTimer = Timer(const Duration(seconds: 1), () {
      if (mounted && widget.controller.loading) setState(() => _slowLoad = true);
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final notice = widget.auth.flashNotice;
      if (notice != null && notice.isNotEmpty) {
        showToast(context, notice);
        widget.auth.consumeNotice();
      }
    });
  }

  @override
  void dispose() {
    _slowTimer?.cancel();
    widget.controller.stop();
    super.dispose();
  }

  Future<void> _open(Thread t) async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => ThreadDetailPage(
          auth: widget.auth,
          threadId: t.threadId,
          seed: t,
        ),
      ),
    );
    // 回来立刻刷一次：详情页里点了通过/打回，列表状态要跟上
    if (mounted) widget.controller.refresh(silent: true);
  }

  /// 建群。只问名字，不问需求：群先当聊天用，@ 需求 bot 才开流程。
  ///
  /// 创建动作放在对话框里面做（而不是先关窗再建）：名字被后端拒掉时
  /// 用户还在原来的输入框里，改了再按一次就行，输入不会丢。
  Future<void> _create() async {
    Thread? created;
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => _NewGroupDialog(
        botName: widget.controller.botName,
        onCreate: (name) async {
          try {
            created = await widget.controller.create(name);
            return null;
          } catch (e) {
            return '$e';
          }
        },
      ),
    );
    if (ok != true || created == null || !mounted) return;
    await _open(created!);
  }

  /// 加入别人的群：只知道群号也能进，扫码就是省去手输。
  ///
  /// 先查一下群叫什么、几个人，再让人确认加入——只凭一串群号直接进群，
  /// 进错了还得再退，多一步确认反而更快。
  Future<void> _join() async {
    final joined = await showDialog<bool>(
      context: context,
      builder: (_) => _JoinDialog(auth: widget.auth),
    );
    if (joined == true && mounted) {
      await widget.controller.refresh(silent: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: widget.controller,
      builder: (context, _) => Scaffold(
        appBar: AppBar(
          title: const Text('群'),
          actions: [
            IconButton(
              tooltip: '加入群',
              icon: const Icon(Icons.group_add_outlined),
              onPressed: _join,
            ),
            // 建群不限角色：群是私有的，谁都能建一个自己的群当群主，
            // 然后在自己群里提需求。以前这里锁 startRequirement，
            // 普通成员的「建群」入口直接消失，永远进不了流程。
            if (widget.auth.perms.createGroup)
              IconButton(
                tooltip: '建群',
                icon: const Icon(Icons.add_comment_outlined),
                onPressed: _create,
              ),
            IconButton(
              tooltip: '刷新',
              icon: const Icon(Icons.refresh),
              onPressed: () {
                setState(() => _slowLoad = true);
                widget.controller.refresh();
              },
            ),
          ],
        ),
        body: _body(context),
      ),
    );
  }

  Widget _body(BuildContext context) {
    final c = widget.controller;
    if (c.firstLoad && c.loading) {
      return _slowLoad ? const Center(child: CircularProgressIndicator()) : const SizedBox.shrink();
    }
    if (c.error != null && c.threads.isEmpty) {
      return _ErrorState(message: c.error!, onRetry: () => c.refresh());
    }
    if (c.threads.isEmpty) {
      return Column(
        children: [
          // 引擎掉线时先说清楚：聊天照旧，只是 @ 了没人接。
          if (c.engineOnline == false)
            Padding(
              padding: EdgeInsets.fromLTRB(AppInset.page, AppSpace.md, AppInset.page, 0),
              child: _EngineOfflineBanner(botName: c.botName),
            ),
          Expanded(
            child: _EmptyState(
              canCreate: widget.auth.perms.createGroup,
              onCreate: _create,
              botName: c.botName,
            ),
          ),
        ],
      );
    }

    return RefreshIndicator(
      onRefresh: () => c.refresh(),
      child: ListView(
        // 下拉刷新需要列表本身可滚；内容不满一屏时也要能拉
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(AppInset.page, AppSpace.xs, AppInset.page, AppSpace.xl),
        children: [
          if (c.engineOnline == false) _EngineOfflineBanner(botName: c.botName),
          // 不分「等你确认 / 其它」两组：这一页现在只回答「哪个群有新消息」，
          // 排序交给服务端的最后活跃时间，分组会把同一件事说两遍。
          for (final t in c.threads)
            _ThreadCard(thread: t, myId: widget.auth.user?.id, onTap: () => _open(t)),
        ],
      ),
    );
  }
}

/// 未读角标。
///
/// 不用品牌蓝：蓝在这套界面里表示「可点」，红点表示「有新东西」，
/// 两者是不同语义。超过 99 显示 99+，数字本身也是给色弱用户的第二载体。
class _UnreadBadge extends StatelessWidget {
  const _UnreadBadge({required this.count});

  final int count;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final text = count > 99 ? '99+' : '$count';
    return Container(
      constraints: const BoxConstraints(minWidth: 18),
      height: 18,
      padding: const EdgeInsets.symmetric(horizontal: 5),
      decoration: BoxDecoration(
        color: scheme.error,
        borderRadius: BorderRadius.circular(AppRadius.pill),
        // 描边让红点在深色头像上也有一圈底气，不至于糊成一团
        border: Border.all(color: scheme.surface, width: 1.5),
      ),
      alignment: Alignment.center,
      child: Text(
        text,
        style: AppText.caption.copyWith(
          color: scheme.onError,
          fontWeight: FontWeight.w600,
          height: 1,
        ),
      ),
    );
  }
}

/// 一个群。就三样东西：头像（右上角挂未读红点）、群名、最后一条消息。
///
/// 阶段和状态一概不放在这里——列表只回答「哪个群有新东西」，要看进度
/// 进群看。卡片上堆四五种信息，扫一眼反而挑不出该点哪个。
class _ThreadCard extends StatelessWidget {
  const _ThreadCard({required this.thread, required this.onTap, this.myId});

  final Thread thread;
  final VoidCallback onTap;

  /// 当前登录用户 id：用来判断最后一条是不是自己说的（决定加不加「我：」）
  final String? myId;

  /// 第二行文案。没人说过话时给一句占位，别留空行。
  String _preview() {
    final p = thread.lastMessage;
    if (p == null) return thread.mode == 'chat' ? '群聊，还没人说话' : '还没提需求';
    if (p.text.isEmpty) return '（没有文字的消息）';
    // 只给自己发的加前缀：别人的话原样显示，加了昵称反而多一层噪声
    final mine = p.role == 'user' && (p.userId == null || myId == null || p.userId == myId);
    return mine ? '我：${p.text}' : p.text;
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final t = thread;
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpace.sm),
      child: Card(
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(AppRadius.medium),
          child: Padding(
            padding: const EdgeInsets.all(AppSpace.sm),
            child: Row(
              children: [
                // 红点挂在头像右上角：群名可能很长，放头像上不会被挤掉，
                // 也像 IM 那样一眼看到哪个群有新消息。
                Stack(
                  clipBehavior: Clip.none,
                  children: [
                    InitialAvatar(name: t.groupName ?? t.name ?? '未命名群', size: 48),
                    if (t.hasUnread)
                      Positioned(top: -4, right: -6, child: _UnreadBadge(count: t.unread)),
                  ],
                ),
                const SizedBox(width: AppSpace.sm),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        // 这里是群列表，主身份是群名：一个群里可能换过几轮需求，
                        // 拿需求名当标题会让人以为列表里是另一批群。
                        t.groupName ?? t.name ?? '未命名群',
                        style: AppText.titleS.copyWith(
                          color: theme.colorScheme.onSurface,
                          fontWeight: FontWeight.w600,
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                      const SizedBox(height: AppSpace.xxs),
                      Text(
                        _preview(),
                        // 未读时第二行用正文色：一眼能看出「有新的」比只看红点更明确，
                        // 颜色只是辅助，红点上的数字才是主信号
                        style: AppText.bodyS.copyWith(
                          color: t.hasUnread
                              ? theme.colorScheme.onSurface
                              : theme.colorScheme.onSurfaceVariant,
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ],
                  ),
                ),
                if (t.running) ...[
                  const SizedBox(width: AppSpace.xs),
                  SizedBox(
                    width: AppSpace.md,
                    height: AppSpace.md,
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      color: theme.colorScheme.primary,
                    ),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _EmptyState extends StatelessWidget {
  const _EmptyState({
    required this.canCreate,
    required this.onCreate,
    required this.botName,
  });

  final bool canCreate;
  final VoidCallback onCreate;
  final String botName;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(AppSpace.xxl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              Icons.inbox_outlined,
              size: AppSpace.huge + AppSpace.xs,
              color: theme.colorScheme.onSurfaceVariant.withValues(alpha: 0.5),
            ),
            const SizedBox(height: AppSpace.md),
            Text('还没有群', style: AppText.titleM.copyWith(color: theme.colorScheme.onSurface)),
            const SizedBox(height: AppSpace.xs),
            Text(
              canCreate ? '先建个群。想聊天就聊，要干活就 @$botName 说一句。' : '等管理员建第一个群。',
              textAlign: TextAlign.center,
              style: AppText.bodyS.copyWith(color: theme.colorScheme.onSurfaceVariant),
            ),
            if (canCreate) ...[
              const SizedBox(height: AppSpace.xl),
              FilledButton.icon(
                onPressed: onCreate,
                icon: const Icon(Icons.add, size: 20),
                label: const Text('建群'),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// 引擎掉线的横幅。
///
/// 不挡住整页：群和消息都在 IM 上，跟引擎死没死没关系。只是「@ 了会不会
/// 有人接」这件事变了，得让用户知道，否则他会以为按钮坏了。
class _EngineOfflineBanner extends StatelessWidget {
  const _EngineOfflineBanner({required this.botName});

  /// 名字从服务端来：它可配置，文案里不能写死。
  final String botName;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      margin: const EdgeInsets.only(bottom: AppSpace.sm),
      padding: const EdgeInsets.all(AppSpace.sm),
      decoration: BoxDecoration(
        color: theme.colorScheme.errorContainer,
        borderRadius: BorderRadius.circular(AppRadius.medium),
      ),
      child: Row(
        children: [
          Icon(Icons.cloud_off_outlined, size: 20, color: theme.colorScheme.onErrorContainer),
          const SizedBox(width: AppSpace.xs),
          Expanded(
            child: Text(
              '需求引擎没连上。群还能照常聊，只是 @$botName 暂时没人接。',
              style: AppText.bodyS.copyWith(color: theme.colorScheme.onErrorContainer),
            ),
          ),
        ],
      ),
    );
  }
}

class _ErrorState extends StatelessWidget {
  const _ErrorState({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(AppSpace.xxl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.cloud_off_outlined, size: 48, color: theme.colorScheme.error),
            const SizedBox(height: AppSpace.md),
            Text('拉不到群列表', style: AppText.titleM.copyWith(color: theme.colorScheme.onSurface)),
            const SizedBox(height: AppSpace.xs),
            Text(
              message,
              textAlign: TextAlign.center,
              style: AppText.bodyS.copyWith(color: theme.colorScheme.onSurfaceVariant),
            ),
            const SizedBox(height: AppSpace.xl),
            OutlinedButton(onPressed: onRetry, child: const Text('重试')),
          ],
        ),
      ),
    );
  }
}

/// 建群的输入框：只要一个名字。
///
/// 这里刻意不收需求描述——群先当普通聊天用，需要 agent 干活时再在群里
/// @ 它一句。先弹窗问需求再建群，等于把「群」降级成需求的包装壳。
class _NewGroupDialog extends StatefulWidget {
  const _NewGroupDialog({required this.onCreate, required this.botName});

  /// 返回 null 表示成功，返回字符串表示要展示给用户的错误。
  final Future<String?> Function(String name) onCreate;

  /// agent 账号昵称，写进 helperText——名字由服务端给，这里不写死
  final String botName;

  @override
  State<_NewGroupDialog> createState() => _NewGroupDialogState();
}

class _NewGroupDialogState extends State<_NewGroupDialog> {
  final _name = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final name = _name.text.trim();
    if (name.isEmpty) {
      setState(() => _error = '起个名字吧');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    final err = await widget.onCreate(name);
    if (!mounted) return;
    if (err == null) {
      Navigator.of(context).pop(true);
      return;
    }
    setState(() {
      _busy = false;
      _error = err;
    });
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('建个群'),
      content: TextField(
        controller: _name,
        autofocus: true,
        enabled: !_busy,
        maxLength: 40,
        textInputAction: TextInputAction.done,
        onSubmitted: (_) => _busy ? null : _submit(),
        // 计数器只在快写满时才出现：一进来就挂着「还可以输 40 个字符」，
        // 等于在用户还没打字前就提醒他可能写错。
        buildCounter: (_, {required currentLength, required isFocused, maxLength}) =>
            currentLength > 32 ? Text('$currentLength / $maxLength') : null,
        decoration: InputDecoration(
          labelText: '群名',
          hintText: '比如：首页改版、登录体验',
          helperText: '先当群聊用，要做事时 @${widget.botName} 说一句。',
          errorText: _error,
        ),
      ),
      actions: [
        TextButton(
          onPressed: _busy ? null : () => Navigator.of(context).pop(false),
          child: const Text('取消'),
        ),
        FilledButton(
          onPressed: _busy ? null : _submit,
          child: _busy
              ? const SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Text('建群'),
        ),
      ],
    );
  }
}

/// 加入群：输群号或扫码，先看群名和人数再确认。
///
/// 群号就是 threadId，没有另造一套编号——多一套映射就多一处可能对不上的地方。
class _JoinDialog extends StatefulWidget {
  const _JoinDialog({required this.auth});

  final AuthController auth;

  @override
  State<_JoinDialog> createState() => _JoinDialogState();
}

class _JoinDialogState extends State<_JoinDialog> {
  final _id = TextEditingController();
  GroupPreview? _preview;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _id.dispose();
    super.dispose();
  }

  Future<void> _scan() async {
    final value = await Navigator.of(context).push<String>(
      MaterialPageRoute(
        builder: (_) => const ScanPage(
          hint: '对准群二维码',
          fallbackHint: '扫不到就把群号手填进去',
        ),
      ),
    );
    if (value == null || value.isEmpty || !mounted) return;
    _id.text = value;
    await _lookup();
  }

  Future<void> _lookup() async {
    final id = _id.text.trim();
    if (id.isEmpty) {
      setState(() => _error = '填个群号，或者点右上角扫一下');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
      _preview = null;
    });
    try {
      final p = await widget.auth.client.groupPreview(id);
      if (!mounted) return;
      setState(() {
        _preview = p;
        _busy = false;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = e.isNetwork ? '连不上服务器' : e.message;
      });
    }
  }

  Future<void> _join() async {
    final p = _preview;
    if (p == null) return;
    if (p.joined) {
      Navigator.of(context).pop(false);
      return;
    }
    setState(() => _busy = true);
    try {
      final r = await widget.auth.client.joinGroup(p.threadId);
      if (!mounted) return;
      Navigator.of(context).pop(true);
      showToast(context, r.joined ? '已加入「${p.groupName}」' : '你已经在这个群里了');
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = e.isNetwork ? '连不上服务器' : e.message;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final p = _preview;
    return AlertDialog(
      title: const Text('加入群'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          TextField(
            controller: _id,
            autofocus: true,
            enabled: !_busy,
            textInputAction: TextInputAction.search,
            onSubmitted: (_) => _lookup(),
            decoration: InputDecoration(
              labelText: '群号',
              hintText: '比如：t9a1b2c3d4e5',
              errorText: _error,
              suffixIcon: IconButton(
                tooltip: '扫码',
                icon: const Icon(Icons.qr_code_scanner),
                onPressed: _busy ? null : _scan,
              ),
            ),
          ),
          if (p != null) ...[
            const SizedBox(height: AppSpace.md),
            Container(
              padding: const EdgeInsets.all(AppSpace.sm),
              decoration: BoxDecoration(
                color: scheme.surfaceContainerLow,
                borderRadius: BorderRadius.circular(AppRadius.medium),
              ),
              child: Row(
                children: [
                  InitialAvatar(name: p.title, size: 40),
                  const SizedBox(width: AppSpace.sm),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(p.title, style: AppText.titleS, maxLines: 1, overflow: TextOverflow.ellipsis),
                        Text(
                          p.joined ? '你已经在这个群里' : '${p.memberCount} 个人',
                          style: AppText.bodyS.copyWith(color: scheme.onSurfaceVariant),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ],
        ],
      ),
      actions: [
        TextButton(
          onPressed: _busy ? null : () => Navigator.of(context).pop(false),
          child: const Text('取消'),
        ),
        if (p == null)
          FilledButton(
            onPressed: _busy ? null : _lookup,
            child: _busy
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Text('查一下'),
          )
        else
          FilledButton(
            onPressed: _busy ? null : _join,
            child: _busy
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : Text(p.joined ? '进去看看' : '加入'),
          ),
      ],
    );
  }
}
