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
        return _ok({'ok': true, 'online': true, 'botName': 'AI员工'});
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
    expect(find.text('先当群聊用，要做事时 @AI员工 说一句。'), findsOneWidget);
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
        return _ok({'ok': true, 'online': false, 'botName': 'AI员工'});
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

  testWidgets('有别人发的没读消息时列表头像上有红点', (tester) async {
    final auth = await _readyAuth((req) async {
      if (req.url.path == '/api/threads') {
        return _ok({
          'threads': [
            {
              'threadId': 't1',
              'groupName': '有未读的群',
              'mode': 'chat',
              'pending': true,
              'lastActiveAt': 1700000002000,
              'unread': 3,
            },
            {
              'threadId': 't2',
              'groupName': '没有未读的群',
              'mode': 'chat',
              'pending': true,
              'lastActiveAt': 1700000001000,
              'unread': 0,
            },
          ],
        });
      }
      if (req.url.path == '/api/engine/status') {
        return _ok({'ok': true, 'online': true, 'botName': 'AI员工'});
      }
      return _ok({});
    });

    await tester.pumpWidget(
      MaterialApp(home: ThreadListPage(auth: auth, controller: ThreadListController(auth: auth))),
    );
    await tester.pumpAndSettle();

    // 数字是第二载体：光靠一个红点，色弱用户分不出「有未读」和「头像装饰」
    expect(find.text('3'), findsOneWidget);
    expect(find.text('0'), findsNothing);
  });

  // 卡片只留三样：头像（挂红点）、群名、最后一条消息。阶段/状态/时间
  // 都收进详情页了——列表要回答的是「哪个群有新东西」，不是「跑到哪一步」。
  testWidgets('群卡片只显示群名和最后一条消息', (tester) async {
    final auth = await _readyAuth((req) async {
      if (req.url.path == '/api/threads') {
        return _ok({
          'threads': [
            {
              'threadId': 't1',
              'groupName': '产品讨论',
              'mode': 'requirement',
              'pending': false,
              'stage': '等待确认方案',
              'stageStatus': '等你确认',
              'waitingLabel': '确认一下首页那个弹窗要不要每次都弹',
              'lastActiveAt': 1700000000000,
              'lastMessage': {
                'seq': 3,
                'role': 'bot',
                'kind': 'text',
                'text': '这一轮我先拆成三块，你看看顺序对不对',
              },
            },
          ],
        });
      }
      if (req.url.path == '/api/engine/status') {
        return _ok({'ok': true, 'online': true, 'botName': 'AI员工'});
      }
      return _ok({});
    });

    await tester.pumpWidget(
      MaterialApp(home: ThreadListPage(auth: auth, controller: ThreadListController(auth: auth))),
    );
    await tester.pumpAndSettle();

    expect(find.text('产品讨论'), findsOneWidget);
    expect(find.textContaining('这一轮我先拆成三块'), findsOneWidget);
    // 阶段、状态、时间、等待理由都不该出现在卡片上
    expect(find.textContaining('等待确认方案'), findsNothing);
    expect(find.textContaining('等你确认'), findsNothing);
    expect(find.textContaining('要不要每次都弹'), findsNothing);
    expect(find.textContaining('年前'), findsNothing);
  });

  testWidgets('自己发的最后一条带「我：」前缀，别人的不带', (tester) async {
    final auth = await _readyAuth((req) async {
      if (req.url.path == '/api/threads') {
        return _ok({
          'threads': [
            {
              'threadId': 't1',
              'groupName': '我说最后一句',
              'lastActiveAt': 1700000002000,
              'lastMessage': {
                'seq': 2,
                'role': 'user',
                // _readyAuth 里登录的账号 id 是 u1
                'userId': 'u1',
                'kind': 'text',
                'text': '我先按这个方案做',
              },
            },
            {
              'threadId': 't2',
              'groupName': '别人说最后一句',
              'lastActiveAt': 1700000001000,
              'lastMessage': {
                'seq': 5,
                'role': 'user',
                'userId': 'u2',
                'kind': 'text',
                'text': '我这边看下来没问题',
              },
            },
          ],
        });
      }
      if (req.url.path == '/api/engine/status') {
        return _ok({'ok': true, 'online': true, 'botName': 'AI员工'});
      }
      return _ok({});
    });

    await tester.pumpWidget(
      MaterialApp(home: ThreadListPage(auth: auth, controller: ThreadListController(auth: auth))),
    );
    await tester.pumpAndSettle();

    expect(find.text('我：我先按这个方案做'), findsOneWidget);
    // 别人的话原样显示：加昵称前缀只是多一层噪声
    expect(find.text('我这边看下来没问题'), findsOneWidget);
  });

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
        return _ok({'ok': true, 'online': false, 'botName': 'AI员工'});
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

  // 顶部那排只放「需求进度」和「待决策」：纯聊天群没有这两样，
  // 不该为了填满而挂一个「群聊」。
  testWidgets('纯聊天群不显示顶部标签，但保留分割线', (tester) async {
    final auth = await _readyAuth((req) async {
      if (req.url.path == '/api/threads/t1') {
        return _ok({
          'thread': {
            'threadId': 't1',
            'groupName': '产品讨论',
            'mode': 'chat',
            'pending': true,
            'stages': [],
          },
        });
      }
      if (req.url.path == '/api/threads/t1/messages') {
        return _ok({'messages': [], 'lastSeq': 0});
      }
      return _ok({});
    });

    await tester.pumpWidget(
      MaterialApp(home: ThreadDetailPage(auth: auth, threadId: 't1')),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('群聊'), findsNothing);
    expect(find.text('待提需求'), findsNothing);
    // 标签没了，但分割线属于整个标题栏，仍然要在——否则标题栏和消息区
    // 连成一片白，看不出边界
    expect(find.byType(Divider), findsOneWidget);

    await tester.pumpWidget(const SizedBox.shrink());
  });

  // 气泡里的 @名字：跟输入框一个颜色，别人一眼看出这句叫了谁。
  testWidgets('气泡里的 @ 名字用主题蓝', (tester) async {
    final auth = await _readyAuth((req) async {
      if (req.url.path == '/api/threads/t1') {
        return _ok({
          'thread': {
            'threadId': 't1',
            'groupName': '产品讨论',
            'mode': 'chat',
            'pending': true,
            'stages': [],
          },
        });
      }
      if (req.url.path == '/api/threads/t1/messages') {
        return _ok({
          'messages': [
            {
              'seq': 1,
              'at': DateTime.now().millisecondsSinceEpoch,
              'role': 'user',
              'kind': 'text',
              'payload': {'text': '@AI员工 加个返回顶部按钮'},
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

    final primary = Theme.of(tester.element(find.byType(ThreadDetailPage)))
        .colorScheme
        .primary;
    final rich = tester.widget<RichText>(
      find.descendant(
        of: find.byType(SelectionArea),
        matching: find.byType(RichText),
      ),
    );
    final colored = <String>[];
    rich.text.visitChildren((s) {
      if (s is TextSpan && s.text != null && s.style?.color == primary) {
        colored.add(s.text!);
      }
      return true;
    });
    expect(colored, ['@AI员工']);

    await tester.pumpWidget(const SizedBox.shrink());
  });

  // 卡片和气泡是两条消息，贴在一起时看起来像一条消息被切成两个圆角。
  testWidgets('气泡和提问卡片之间留出间隔', (tester) async {
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
              'at': at - 60000,
              'role': 'bot',
              'kind': 'text',
              'payload': {'text': '收到，开始处理：加一个返回顶部按钮'},
            },
            {
              'seq': 2,
              'at': at,
              'role': 'bot',
              'kind': 'ask',
              'payload': {
                'title': '需要你拍板',
                'submitLabel': '提交',
                'questions': [
                  {
                    'id': 'q1',
                    'title': '什么时候上线？',
                    'kind': 'single',
                    'options': [
                      {'id': 'a', 'label': '这周'},
                      {'id': 'b', 'label': '下周'},
                    ],
                  },
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

    final bubble = tester.getRect(find.text('收到，开始处理：加一个返回顶部按钮'));
    final card = tester.getRect(find.text('需要你拍板'));
    // 气泡文字到卡片标题至少要跨过气泡内边距(8) + 卡片上间距(12)。
    // 只断言「有间隔」不够：原来的 8 也是间隔，但肉眼看着是连在一起的。
    expect(card.top - bubble.bottom, greaterThanOrEqualTo(16));

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

  // 服务端 lastSeq 只要落后一点，轮询就会把同一批消息再发一遍；
  // 不去重的话聊天记录里会并排出现两条一模一样的。
  testWidgets('轮询到重复 seq 时不会出现重影', (tester) async {
    var polls = 0;
    final auth = await _readyAuth((req) async {
      if (req.url.path == '/api/threads/t1') {
        return _ok({
          'thread': {
            'threadId': 't1',
            'groupName': '产品讨论',
            'mode': 'chat',
            'pending': true,
            'stages': [],
          },
        });
      }
      if (req.url.path == '/api/threads/t1/messages') {
        polls++;
        return _ok({
          'messages': [
            {
              'seq': 1,
              'at': DateTime.now().millisecondsSinceEpoch,
              'role': 'bot',
              'kind': 'text',
              'payload': {'text': '同一句话'},
            },
          ],
          // 故意把 lastSeq 报小：第二轮 since=0 会把这句再发一次
          'lastSeq': 0,
        });
      }
      return _ok({});
    });

    await tester.pumpWidget(
      MaterialApp(home: ThreadDetailPage(auth: auth, threadId: 't1')),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('同一句话'), findsOneWidget);

    // 3 秒一次的轮询：等它再拉一轮，返回的还是 seq 1
    await tester.pump(const Duration(seconds: 4));
    await tester.pump(const Duration(milliseconds: 300));
    expect(polls, greaterThan(1));
    expect(find.text('同一句话'), findsOneWidget);

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
    // 建群入口看的是 createGroup（人人可建），startRequirement 只管账号层面
    'createGroup': true,
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
