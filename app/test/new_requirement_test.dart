import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:login/login.dart';
import 'package:network/network.dart';
import 'package:qqbot_app/ui/thread_detail_page.dart';
import 'package:qqbot_app/ui/widgets/requirement_card.dart';

/// 起需求的入口从「群里 @ 一句」改成「底部按钮 + 弹窗」之后的行为。
///
/// 钉四件事：
/// 1) 有权限、且这个群现在开得起来时，底部才有「发起新需求」；
/// 2) 群里有需求在跑时按钮不出现（不是置灰）；
/// 3) 弹窗提交打到 POST /api/requirements，参数全在 body；
/// 4) 需求卡片只展示填的内容，未知 kind 有兜底文案而不是空白。
void main() {
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));

  testWidgets('能开新需求时底部出现「发起新需求」，且不再显示 @ 标签', (tester) async {
    final auth = await _readyAuth(_detailHandler(thread: {
      'threadId': 't1',
      'groupName': '产品讨论',
      'mode': 'chat',
      'pending': true,
      'canStart': true,
      'canNewRequirement': true,
      'stageStatus': '待提需求',
      'stages': [],
    }));

    await tester.pumpWidget(MaterialApp(home: ThreadDetailPage(auth: auth, threadId: 't1')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('发起新需求'), findsOneWidget);
    // @ 已经不起需求了，这时候留着它是在教用户走不通的路
    expect(find.text('@AI员工'), findsNothing);

    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('群里有需求在跑时按钮不出现，@ 标签留着当聊天提示', (tester) async {
    final auth = await _readyAuth(_detailHandler(thread: {
      'threadId': 't1',
      'groupName': '产品讨论',
      'mode': 'requirement',
      'pending': false,
      'canStart': true,
      // 需求在跑：服务端会把它算成 false
      'canNewRequirement': false,
      'stage': '设计',
      'stageStatus': '进行中',
      'stages': [],
    }));

    await tester.pumpWidget(MaterialApp(home: ThreadDetailPage(auth: auth, threadId: 't1')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('发起新需求'), findsNothing);
    expect(find.text('@AI员工'), findsOneWidget);

    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('没权限时按钮也不出现', (tester) async {
    final auth = await _readyAuth(_detailHandler(thread: {
      'threadId': 't1',
      'groupName': '产品讨论',
      'mode': 'chat',
      'pending': true,
      'canStart': false,
      'canNewRequirement': false,
      'stages': [],
    }, startRequirementPerm: false));

    await tester.pumpWidget(MaterialApp(home: ThreadDetailPage(auth: auth, threadId: 't1')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('发起新需求'), findsNothing);

    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('弹窗提交打到 POST /api/requirements，参数全在 body', (tester) async {
    late http.Request posted;
    final auth = await _readyAuth(_detailHandler(
      thread: {
        'threadId': 't1',
        'groupName': '产品讨论',
        'mode': 'chat',
        'pending': true,
        'canStart': true,
        'canNewRequirement': true,
        'stages': [],
      },
      onStart: (req) => posted = req,
    ));

    await tester.pumpWidget(MaterialApp(home: ThreadDetailPage(auth: auth, threadId: 't1')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    await tester.tap(find.text('发起新需求'));
    await tester.pumpAndSettle();

    // 弹窗：需求内容（多行必填）+ 名称（可选）+ 目标 APP（下拉）
    expect(find.text('需求内容'), findsOneWidget);
    expect(find.text('需求名称（可选）'), findsOneWidget);
    expect(find.text('目标 APP'), findsOneWidget);

    // 页面底部本来就有聊天输入框，所以要在弹窗内部找那两个输入框
    final fields = find.descendant(
      of: find.byType(AlertDialog),
      matching: find.byType(TextField),
    );
    await tester.enterText(fields.at(0), '给欢迎弹窗加一个关闭按钮');
    await tester.enterText(fields.at(1), '关闭按钮');
    await tester.pump();

    await tester.tap(find.text('提交'));
    await tester.pumpAndSettle();

    expect(posted.url.path, '/api/requirements');
    expect(jsonDecode(posted.body), {
      'threadId': 't1',
      'text': '给欢迎弹窗加一个关闭按钮',
      'name': '关闭按钮',
      'repoId': 'app',
    });

    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('需求内容为空时提交按钮是灰的，点不动', (tester) async {
    final auth = await _readyAuth(_detailHandler(thread: {
      'threadId': 't1',
      'groupName': '产品讨论',
      'mode': 'chat',
      'pending': true,
      'canStart': true,
      'canNewRequirement': true,
      'stages': [],
    }));

    await tester.pumpWidget(MaterialApp(home: ThreadDetailPage(auth: auth, threadId: 't1')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    await tester.tap(find.text('发起新需求'));
    await tester.pumpAndSettle();

    final submit = tester.widget<FilledButton>(
      find.widgetWithText(FilledButton, '提交'),
    );
    // 空内容不能提交：onPressed 为 null 就是禁用态
    expect(submit.onPressed, isNull);

    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('没配项目时空态说清去哪配，也提交不了', (tester) async {
    final auth = await _readyAuth(_detailHandler(
      thread: {
        'threadId': 't1',
        'groupName': '产品讨论',
        'mode': 'chat',
        'pending': true,
        'canStart': true,
        'canNewRequirement': true,
        'stages': [],
      },
      repos: const [],
    ));

    await tester.pumpWidget(MaterialApp(home: ThreadDetailPage(auth: auth, threadId: 't1')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    await tester.tap(find.text('发起新需求'));
    await tester.pumpAndSettle();

    expect(find.textContaining('还没有配置项目'), findsOneWidget);
    expect(
      tester.widget<FilledButton>(find.widgetWithText(FilledButton, '提交')).onPressed,
      isNull,
    );

    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('需求卡片展示名称/正文/目标 APP，不重复写发起人和时间', (tester) async {
    final at = DateTime.now().millisecondsSinceEpoch;
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
        return _ok({
          'messages': [
            {
              'seq': 1,
              'at': at,
              'role': 'bot',
              'kind': 'requirement',
              'payload': {
                'reqId': 'r1',
                'name': '关闭按钮',
                'text': '给欢迎弹窗加一个关闭按钮',
                'repo': {'id': 'app', 'name': 'DoDroidAI', 'platform': 'android'},
              },
            },
          ],
          'lastSeq': 1,
        });
      }
      return _ok({});
    });

    await tester.pumpWidget(MaterialApp(home: ThreadDetailPage(auth: auth, threadId: 't1')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.byType(RequirementCardView), findsOneWidget);
    expect(find.text('关闭按钮'), findsOneWidget);
    expect(find.text('给欢迎弹窗加一个关闭按钮'), findsOneWidget);
    expect(find.text('DoDroidAI'), findsOneWidget);
    // 平台用中文名，不是字面量 android
    expect(find.text('Android'), findsOneWidget);

    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('未知 kind 有兜底文案，不是一条空白消息', (tester) async {
    final at = DateTime.now().millisecondsSinceEpoch;
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
              'at': at,
              'role': 'bot',
              'kind': 'poll',
              'payload': {'text': '投个票'},
            },
          ],
          'lastSeq': 1,
        });
      }
      return _ok({});
    });

    await tester.pumpWidget(MaterialApp(home: ThreadDetailPage(auth: auth, threadId: 't1')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.textContaining('这条消息当前版本看不了'), findsOneWidget);
    // 老消息里带的正文照常显示，别把内容一起藏了
    expect(find.text('投个票'), findsOneWidget);

    await tester.pumpWidget(const SizedBox.shrink());
  });
}

/// 详情页会打三类接口：群、消息、项目列表。默认各给一份能跑起来的最小数据，
/// 需要断言请求体的用例用 onStart 抓一把。
Future<http.Response> Function(http.Request) _detailHandler({
  required Map<String, dynamic> thread,
  List<Map<String, dynamic>>? repos,
  bool startRequirementPerm = true,
  void Function(http.Request)? onStart,
}) {
  return (req) async {
    if (req.url.path == '/api/threads/t1') return _ok({'thread': thread});
    if (req.url.path == '/api/threads/t1/messages') {
      return _ok({'messages': const [], 'lastSeq': 0});
    }
    if (req.url.path == '/api/repos') {
      return _ok({
        'repos': repos ??
            const [
              {'id': 'app', 'name': 'DoDroidAI', 'platform': 'android'},
            ],
      });
    }
    if (req.url.path == '/api/requirements') {
      onStart?.call(req);
      return _ok({'reqId': 'r1', 'name': '关闭按钮'});
    }
    if (req.url.path == '/api/auth/me') return _ok(_me(startRequirementPerm));
    return _ok({});
  };
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
    if (req.url.path == '/api/auth/me') return _ok(_me(true));
    return handler(req);
  });
  final auth = AuthController(
    clientFactory: (url) => ApiClient(baseUrl: url, httpClient: shared),
  );
  await auth.restore();
  expect(auth.stage, AuthStage.ready);
  return auth;
}

Map<String, dynamic> _me(bool startRequirement) => {
  'user': {
    'id': 'u1',
    'username': 'abao',
    'nickname': '产品阿宝',
    'role': 'admin',
    'roleLabel': '系统管理员',
  },
  'can': {
    'createGroup': true,
    'startRequirement': startRequirement,
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
