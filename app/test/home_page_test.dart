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
    expect(find.text('设置'), findsOneWidget);
    // 管理员才看得到账号管理
    expect(find.text('账号管理'), findsOneWidget);

    await tester.tap(find.text('设置'));
    await tester.pumpAndSettle();

    expect(find.text('服务器地址'), findsOneWidget);
    expect(find.text('http://127.0.0.1:7881'), findsOneWidget);
    expect(find.text('换服务器后需要重新登录。'), findsOneWidget);
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
