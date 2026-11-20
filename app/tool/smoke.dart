// 对真实后端跑一遍客户端。
//
// 单元测试用 MockClient 只能证明「请求怎么拼」，证明不了「后端认不认」。
// 这个脚本打真地址，用来在改完 API 或改完客户端后确认契约仍然成立。
//
// 用法（后端要开着 api.enabled）：
//   dart run tool/smoke.dart http://127.0.0.1:7881 用户名 密码
//
// 故意不放进 test/：它依赖外部进程，放进 flutter test 会让 CI 随机红。

import 'dart:io';

import 'package:qqbot_app/api/client.dart';

Future<void> main(List<String> args) async {
  if (args.length < 3) {
    stderr.writeln('用法: dart run tool/smoke.dart <baseUrl> <用户名> <密码>');
    exit(2);
  }
  final baseUrl = normalizeBaseUrl(args[0]);
  final username = args[1];
  final password = args[2];

  var failed = 0;
  void check(String name, bool ok, [String extra = '']) {
    stdout.writeln('${ok ? '✅' : '❌'} $name${extra.isEmpty ? '' : ' — $extra'}');
    if (!ok) failed++;
  }

  final c = ApiClient(baseUrl: baseUrl);
  try {
    final needsFirstAdmin = await c.authStatus();
    check('GET /api/auth/status', true, 'needsFirstAdmin=$needsFirstAdmin');

    final login = await c.login(username: username, password: password);
    check('POST /api/auth/login', login.token.isNotEmpty, 'user=${login.user.displayName}');
    c.token = login.token;

    final me = await c.me();
    check('GET /api/auth/me', me.user.id.isNotEmpty,
        'role=${me.user.roleLabel} confirm=${me.perms.confirm}');

    final threads = await c.listThreads();
    check('GET /api/threads', true, '共 ${threads.length} 条');
    // App 列表只该出现 App 里建的 thread；QQ 群号混进来是回归
    final leaked = threads.where((t) => int.tryParse(t.threadId) != null).toList();
    check('列表没有混入 QQ 群号', leaked.isEmpty,
        leaked.map((e) => e.threadId).join(','));

    if (!me.perms.startRequirement) {
      // 普通成员跑这个脚本也是常见场景（验证「看得见但点不动」），
      // 不该因为建不了需求就报失败。
      check('普通成员没有发起需求的权限', true, 'startRequirement=false，跳过建需求');
      try {
        await c.createThread('普通成员不该建成');
        check('普通成员建需求应当被拒', false, '后端没拦');
      } on ApiException catch (e) {
        check('普通成员建需求被拒', e.statusCode == 403, e.message);
      }

      // m00102 的明确要求：普通成员看得见通过/打回，点了才告诉他不行。
      // 所以这里要验的是「拒绝文案能原样透传到界面」，不是「按钮藏起来」。
      final first = threads.isEmpty ? null : threads.first;
      if (first != null && (first.needsMe || first.blocked)) {
        try {
          await c.approve(first.threadId);
          check('普通成员点通过应当被拒', false, '后端没拦');
        } on ApiException catch (e) {
          check('普通成员点通过被拒且文案可展示', e.statusCode == 403 &&
              e.message.contains('系统管理员') && (e.roleLabel ?? '').isNotEmpty,
              '${e.message}（role=${e.roleLabel}）');
        }
      } else {
        check('普通成员点通过被拒且文案可展示', true, '当前没有待我确认的需求，跳过');
      }
      stdout.writeln(failed == 0 ? '\n全部通过' : '\n\$failed 项失败');
      c.close();
      exit(failed == 0 ? 0 : 1);
    }

    final created = await c.createThread('冒烟测试：加一个返回顶部的按钮');
    check('POST /api/threads', created.threadId.isNotEmpty,
        'threadId=${created.threadId} stage=${created.stage}');
    check('新建的 thread 立刻有阶段', created.stages.isNotEmpty,
        'stages=${created.stages.length}');

    final one = await c.thread(created.threadId);
    check('GET /api/threads/:id', one.threadId == created.threadId);

    final page = await c.messages(created.threadId, since: 0, limit: 50);
    check('GET /api/threads/:id/messages', page.messages.isNotEmpty,
        '共 ${page.messages.length} 条 lastSeq=${page.lastSeq}');
    check('第一条是我说的话',
        page.messages.first.isMine && page.messages.first.text.contains('返回顶部'),
        page.messages.first.text);

    await c.sendMessage(created.threadId, '补充：按钮要能配置位置');
    final after = await c.messages(created.threadId, since: page.lastSeq);
    // 不止一条是正常的：投递后编排层会立刻播一条「收到，开始处理」。
    // 要验证的是增量窗口没错位——第一条必须是我刚发的那句。
    check('POST 消息 + since 增量', after.messages.isNotEmpty && after.messages.first.isMine,
        '新消息 ${after.messages.length} 条，首条=${after.messages.first.text}');

    // 权限：普通成员点通过要被后端拒，且文案能透传到界面
    try {
      await c.approve(created.threadId);
      check('approve 通过', true);
    } on ApiException catch (e) {
      check('approve 被拒（预期在非管理员账号下出现）', e.statusCode == 403, e.message);
    }

    try {
      await c.reject(created.threadId, '');
      check('空原因打回应当被拒', false, '后端没拦');
    } on ApiException catch (e) {
      check('空原因打回被拒', e.statusCode == 400, e.message);
    }
  } on ApiException catch (e) {
    stderr.writeln('❌ 请求失败: ${e.message} (status=${e.statusCode} code=${e.code})');
    failed++;
  } finally {
    c.close();
  }

  stdout.writeln(failed == 0 ? '\n全部通过' : '\n$failed 项失败');
  exit(failed == 0 ? 0 : 1);
}
