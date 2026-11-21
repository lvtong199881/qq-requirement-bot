import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:qqbot_app/api/client.dart';
import 'package:qqbot_app/state/auth.dart';
import 'package:qqbot_app/state/threads.dart';
import 'package:qqbot_app/ui/home_page.dart';
import 'package:qqbot_app/ui/me_page.dart';
import 'package:qqbot_app/ui/server_setup_page.dart';
import 'package:qqbot_app/ui/thread_detail_page.dart';
import 'package:qqbot_app/ui/thread_list_page.dart';

/// 底部导航改造后的三个入口。
///
/// 钉的是这次重排的三条用户可见行为：
/// 1) 服务器地址输入框是多行的（Cloudflare 域名很长，单行看不全）；
/// 2) 列表页不再有提需求 FAB，建群入口在 AppBar，账号入口在「我的」；
/// 3) 「我的 → 设置 → 服务器地址」这条路径能走通。
///
/// 用 IndexedStack 时两个 tab 的页面都留在树里，find.text('群') 会同时命中
/// AppBar 标题和导航标签，所以点导航一律从 NavigationBar 里找。
Finder _navTab(String label) => find.descendant(
  of: find.byType(NavigationBar),
  matching: find.text(label),
);

void main() {
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));

  testWidgets('连接服务器页：输入框多行，不再有说明和提示文案', (tester) async {
    final auth = AuthController();
    await tester.pumpWidget(MaterialApp(home: ServerSetupPage(auth: auth)));
    await tester.pump();

    final field = tester.widget<TextField>(find.byType(TextField));
    expect(field.maxLines, 4);
    expect(field.minLines, 1);

    // 用户明确要删掉的三处说明
    expect(find.text('不填协议也行'), findsNothing);
    expect(find.text('后端要开启 App API'), findsNothing);
    expect(find.text('先填一下后端地址'), findsNothing);

    // 扫码是连接服务器页的新入口
    expect(find.text('扫码'), findsOneWidget);
  });

  testWidgets('我的页展示账号，设置可进服务器地址页', (tester) async {
    final auth = await _readyAuth((req) async => _ok({}));

    await tester.pumpWidget(MaterialApp(home: MePage(auth: auth)));
    await tester.pumpAndSettle();

    expect(find.text('产品阿宝'), findsOneWidget);
    expect(find.text('abao · 系统管理员'), findsOneWidget);
    // 设置项直接以「服务器地址」为标题：点进去能改什么一目了然，
    // 不再多一层只写着「设置」的空壳入口
    expect(find.text('服务器地址'), findsOneWidget);
    // 管理员才看得到账号管理
    expect(find.text('账号管理'), findsOneWidget);

    await tester.tap(find.text('服务器地址'));
    await tester.pumpAndSettle();

    expect(find.text('设置'), findsOneWidget);
    expect(find.text('http://127.0.0.1:7881'), findsWidgets);
    expect(find.textContaining('换服务器后需要重新登录'), findsOneWidget);
  });

  testWidgets('首页底部导航可在群和我的之间切换', (tester) async {
    final auth = await _readyAuth((req) async {
      if (req.url.path == '/api/threads') return _ok({'threads': []});
      return _ok({});
    });
    final controller = ThreadListController(auth: auth);

    await tester.pumpWidget(
      MaterialApp(home: HomePage(auth: auth, controller: controller)),
    );
    await tester.pumpAndSettle();

    expect(find.byType(NavigationBar), findsOneWidget);
    // 群列表空的时候给的是内联的建群按钮，不能再有 FAB 挡住列表
    expect(find.byType(FloatingActionButton), findsNothing);
    expect(find.text('还没有群'), findsOneWidget);
    expect(find.text('退出登录'), findsNothing);

    await tester.tap(_navTab('我的'));
    await tester.pumpAndSettle();

    expect(find.text('退出登录'), findsOneWidget);
    expect(find.text('产品阿宝'), findsOneWidget);

    await tester.tap(_navTab('群'));
    await tester.pumpAndSettle();
    expect(find.text('退出登录'), findsNothing);
  });

  testWidgets('建群只问群名，需求进去再说', (tester) async {
    final auth = await _readyAuth((req) async {
      if (req.url.path == '/api/threads') return _ok({'threads': []});
      if (req.url.path == '/api/engine/status') {
        return _ok({'ok': true, 'online': true, 'botName': '需求bot'});
      }
      return _ok({});
    });
    final controller = ThreadListController(auth: auth);

    await tester.pumpWidget(
      MaterialApp(
        home: ThreadListPage(auth: auth, controller: controller),
      ),
    );
    await tester.pumpAndSettle();

    // 空列表也要有建群入口：以前只有 FAB，列表空了才有按钮
    await tester.tap(find.byTooltip('建群'));
    await tester.pumpAndSettle();

    expect(find.text('建个群'), findsOneWidget);
    expect(find.text('群名'), findsOneWidget);
    // 对话框里只收群名，要不要跑需求进群之后 @ 一句才知道
    expect(find.text('先当群聊用，要做事时 @需求bot 说一句。'), findsOneWidget);
    final field = tester.widget<TextField>(find.byType(TextField));
    expect(field.maxLines, 1);
    expect(find.text('发出去'), findsNothing);
  });

  testWidgets('引擎没连上时列表顶部提示，但群还能进', (tester) async {
    final auth = await _readyAuth((req) async {
      if (req.url.path == '/api/threads') {
        return _ok({
          'threads': [
            {
              'threadId': 't1',
              'groupName': '产品讨论',
              'mode': 'chat',
              'pending': true,
              'stageStatus': null,
              'lastActiveAt': 1700000000000,
            },
          ],
        });
      }
      if (req.url.path == '/api/engine/status') {
        return _ok({'ok': true, 'online': false, 'botName': '需求bot'});
      }
      return _ok({});
    });
    final controller = ThreadListController(auth: auth);

    await tester.pumpWidget(
      MaterialApp(
        home: ThreadListPage(auth: auth, controller: controller),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.textContaining('需求引擎没连上'), findsOneWidget);
    expect(find.text('产品讨论'), findsOneWidget);
  });

  // 规范要求 320 宽（最小的常见机型）不溢出。Flutter 把溢出当异常抛出来，
  // 所以这里不用断言具体像素，跑到不抛就说明布局没崩。
  testWidgets('320 宽下群列表和建群弹窗都不溢出', (tester) async {
    tester.view.physicalSize = const Size(320, 640);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    final auth = await _readyAuth((req) async {
      if (req.url.path == '/api/threads') {
        return _ok({
          'threads': [
            {
              'threadId': 't1',
              'groupName': '一个特别特别长的群名字用来测省略号会不会把标题撑破',
              'mode': 'requirement',
              'pending': false,
              'stage': '等待确认方案',
              'stageStatus': '等你确认',
              'waitingLabel': '确认一下首页那个弹窗要不要每次都弹，还是只弹一次，这决定了后面怎么改',
              'lastActiveAt': 1700000000000,
            },
          ],
        });
      }
      if (req.url.path == '/api/engine/status') {
        return _ok({'ok': true, 'online': false, 'botName': '需求bot'});
      }
      return _ok({});
    });
    final controller = ThreadListController(auth: auth);

    await tester.pumpWidget(
      MaterialApp(home: ThreadListPage(auth: auth, controller: controller)),
    );
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);

    await tester.tap(find.byTooltip('建群'));
    await tester.pumpAndSettle();
    expect(find.text('建个群'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  // 详情页输入区有 @ 提示行 + 右侧按钮，是横向空间最紧的地方；
  // 提问卡片也常在这一屏里（最宽的一张是「需要你拍板」多题卡）。
  testWidgets('320 宽下群详情输入区和提问卡片不溢出', (tester) async {
    tester.view.physicalSize = const Size(320, 640);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    final auth = await _readyAuth((req) async {
      if (req.url.path == '/api/threads/t1') {
        return _ok({
          'thread': {
            'threadId': 't1',
            'groupName': '产品讨论',
            'mode': 'requirement',
            'pending': false,
            'stage': '等待确认方案',
            'stageStatus': '等你确认',
            'canAct': true,
            'needsMe': true,
            'stages': [
              {'name': '需求澄清', 'status': '已完成'},
              {'name': '确认方案', 'status': '进行中'},
            ],
          },
        });
      }
      if (req.url.path == '/api/threads/t1/messages') {
        return _ok({
          'messages': [
            {
              'seq': 1,
              'at': DateTime.now().millisecondsSinceEpoch,
              'role': 'bot',
              'kind': 'ask',
              'payload': {
                'title': '需要你拍板',
                'submitLabel': '提交',
                'questions': [
                  {
                    'id': 'q1',
                    'title': '欢迎弹窗什么时候出现比较合适？给新用户看还是所有人看？',
                    'kind': 'single',
                    'allowInput': true,
                    'inputLabel': '都不是？自己写',
                    'options': [
                      {'id': 'a', 'label': '首次启动时给新用户看（推荐）'},
                      {'id': 'b', 'label': '每次启动都弹，所有人可见'},
                    ],
                  },
                ],
              },
            },
          ],
          'lastSeq': 1,
        });
      }
      return _ok({});
    });

    await tester.pumpWidget(
      MaterialApp(home: ThreadDetailPage(auth: auth, threadId: 't1')),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('需要你拍板'), findsOneWidget);
    expect(find.text('提交'), findsOneWidget);
    expect(tester.takeException(), isNull);

    // 详情页 3 秒轮询一次，测试结束前要把页面拆掉，
    // 否则计时器会挂到下一个用例里
    await tester.pumpWidget(const SizedBox.shrink());
  });

  // 回答了卡片的那条消息：问题一行、选项缩进一行、字号更小颜色更淡，
  // 否则十五道题在气泡里连成一片，看不出哪句是问哪句是答。
  testWidgets('卡片答案在气泡里分行缩进，问题比选项重', (tester) async {
    final auth = await _readyAuth((req) async {
      if (req.url.path == '/api/threads/t1') {
        return _ok({
          'thread': {
            'threadId': 't1',
            'groupName': '产品讨论',
            'mode': 'requirement',
            'pending': false,
            'stage': '需求澄清',
            'stageStatus': '进行中',
            'stages': [],
          },
        });
      }
      if (req.url.path == '/api/threads/t1/messages') {
        final at = DateTime.now().millisecondsSinceEpoch;
        return _ok({
          'messages': [
            {
              'seq': 1,
              'at': at,
              'role': 'bot',
              'kind': 'ask',
              'payload': {
                'title': '需要你拍板',
                'submitLabel': '提交',
                'questions': [
                  {
                    'id': 'q1',
                    'title': '是否埋曝光？',
                    'kind': 'single',
                    'allowInput': true,
                    'inputLabel': '自己写',
                    'options': [
                      {'id': 'a', 'label': '先只埋点击'},
                      {'id': 'b', 'label': '先不做'},
                    ],
                  },
                ],
              },
            },
            {
              'seq': 2,
              'at': at + 1000,
              'role': 'user',
              'kind': 'text',
              'payload': {
                'text': '是否埋曝光？\n  A. 先只埋点击',
                'askSeq': 1,
                'answers': [
                  {'qid': 'q1', 'optionIds': ['a'], 'input': ''},
                ],
              },
            },
          ],
          'lastSeq': 2,
        });
      }
      return _ok({});
    });

    await tester.pumpWidget(
      MaterialApp(home: ThreadDetailPage(auth: auth, threadId: 't1')),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    // 卡片上也写着同一句题干，所以只在这条气泡里找（气泡包在 SelectionArea 里）
    final inBubble = find.byType(SelectionArea);
    final questionLine = find.descendant(
      of: inBubble,
      matching: find.text('是否埋曝光？'),
    );
    final option = find.descendant(of: inBubble, matching: find.text('A. 先只埋点击'));

    expect(questionLine, findsOneWidget);
    expect(option, findsOneWidget);
    final q = tester.widget<Text>(questionLine);
    final o = tester.widget<Text>(option);
    expect(o.style!.fontSize, lessThan(q.style!.fontSize!));
    expect(o.style!.color, isNot(q.style!.color));
    expect(
      tester.getTopLeft(option).dx,
      greaterThan(tester.getTopLeft(questionLine).dx),
    );

    await tester.pumpWidget(const SizedBox.shrink());
  });
}

Future<AuthController> _readyAuth(
  Future<http.Response> Function(http.Request req) handler,
) async {
  FlutterSecureStorage.setMockInitialValues({
    'server_base_url': 'http://127.0.0.1:7881',
    'auth_token': 'good',
    'auth_username': 'abao',
  });
  final shared = MockClient((req) async {
    if (req.url.path == '/api/auth/me') return _ok(_me);
    return handler(req);
  });
  final auth = AuthController(
    clientFactory: (url) => ApiClient(baseUrl: url, httpClient: shared),
  );
  await auth.restore();
  expect(auth.stage, AuthStage.ready);
  return auth;
}

const _me = {
  'user': {
    'id': 'u1',
    'username': 'abao',
    'nickname': '产品阿宝',
    'role': 'admin',
    'roleLabel': '系统管理员',
  },
  'can': {
    'startRequirement': true,
    'confirm': true,
    'command': true,
    'comment': true,
    'read': true,
  },
};

http.Response _ok(Map<String, dynamic> body) => http.Response(
  jsonEncode({'ok': true, ...body}),
  200,
  headers: {'content-type': 'application/json; charset=utf-8'},
);
