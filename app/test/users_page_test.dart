import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:qqbot_app/api/client.dart';
import 'package:qqbot_app/state/auth.dart';
import 'package:qqbot_app/ui/users_page.dart';

/// 账号管理页。
///
/// 这页是「没有找回密码」的兜底，所以钉住两件事：
/// 1) 每个账号都能看到重置密码入口——看不到就等于该成员永远登不回来；
/// 2) 操作打的是后端，成功后列表跟着变，不是前端自己改一份假的。
void main() {
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));

  testWidgets('列出所有账号，每个都有重置密码入口', (tester) async {
    final auth = await readyAuth((req) async {
      if (req.url.path == '/api/users' && req.method == 'GET') {
        return _ok({
          'users': [
            _user('u1', 'abao', '产品阿宝', 'admin', '系统管理员'),
            _user('u2', 'xiaoming', '开发小明', 'member', '普通成员'),
          ],
        });
      }
      if (req.url.path == '/api/auth/me') return _ok(_me);
      return _ok({});
    });

    await tester.pumpWidget(MaterialApp(home: UsersPage(auth: auth)));
    await tester.pumpAndSettle();

    // 自己那行标出「我」，不然管理员容易误操作自己
    expect(find.text('产品阿宝（我）'), findsOneWidget);
    expect(find.text('开发小明'), findsOneWidget);
    expect(find.text('重置密码'), findsNWidgets(2));
  });

  testWidgets('停用接口按账号 id 打到后端，成功后状态跟着变', (tester) async {
    var disabled = false;
    final calls = <String>[];
    final auth = await readyAuth((req) async {
      if (req.url.path == '/api/users' && req.method == 'GET') {
        return _ok({
          'users': [
            _user('u1', 'abao', '产品阿宝', 'admin', '系统管理员'),
            _user('u2', 'xiaoming', '开发小明', 'member', '普通成员', disabled: disabled),
          ],
        });
      }
      if (req.url.path == '/api/users/u2/disabled') {
        calls.add(req.body);
        disabled = (jsonDecode(req.body) as Map)['disabled'] == true;
        return _ok({});
      }
      if (req.url.path == '/api/auth/me') return _ok(_me);
      return _ok({});
    });

    await tester.pumpWidget(MaterialApp(home: UsersPage(auth: auth)));
    await tester.pumpAndSettle();
    expect(find.text('已停用'), findsNothing);

    await tester.tap(find.text('停用').last);
    await tester.pumpAndSettle();

    expect(calls, ['{"disabled":true}']);
    // 刷新后那条要显示「已停用」，说明界面信的是后端返回的列表
    expect(find.text('已停用'), findsOneWidget);
    expect(find.text('恢复'), findsOneWidget);
  });

  testWidgets('重置密码必须先填够 6 位', (tester) async {
    final calls = <String>[];
    final auth = await readyAuth((req) async {
      if (req.url.path == '/api/users' && req.method == 'GET') {
        return _ok({
          'users': [_user('u2', 'xiaoming', '开发小明', 'member', '普通成员')],
        });
      }
      if (req.url.path == '/api/users/u2/password') {
        calls.add(req.body);
        return _ok({});
      }
      if (req.url.path == '/api/auth/me') return _ok(_me);
      return _ok({});
    });

    await tester.pumpWidget(MaterialApp(home: UsersPage(auth: auth)));
    await tester.pumpAndSettle();

    await tester.tap(find.text('重置密码'));
    await tester.pumpAndSettle();

    // 太短的密码要当场拦下来，别让后端拒了才发现
    await tester.enterText(find.byType(TextField), '123');
    await tester.tap(find.text('重置'));
    await tester.pumpAndSettle();
    expect(find.text('密码至少 6 位'), findsOneWidget);
    expect(calls, isEmpty);

    await tester.enterText(find.byType(TextField), 'newpass123');
    await tester.tap(find.text('重置'));
    await tester.pumpAndSettle();
    expect(calls, ['{"password":"newpass123"}']);
  });

  testWidgets('后端拒绝时把原话显示出来', (tester) async {
    final auth = await readyAuth((req) async {
      if (req.url.path == '/api/users' && req.method == 'GET') {
        return _ok({
          'users': [_user('u1', 'abao', '产品阿宝', 'admin', '系统管理员')],
        });
      }
      if (req.url.path == '/api/users/u1/role') {
        return http.Response(
          jsonEncode({'ok': false, 'error': '最后一个管理员不能降级'}),
          400,
          headers: {'content-type': 'application/json; charset=utf-8'},
        );
      }
      if (req.url.path == '/api/auth/me') return _ok(_me);
      return _ok({});
    });

    await tester.pumpWidget(MaterialApp(home: UsersPage(auth: auth)));
    await tester.pumpAndSettle();

    await tester.tap(find.text('降为成员'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('确定'));
    await tester.pumpAndSettle();

    expect(find.text('最后一个管理员不能降级'), findsOneWidget);
  });
}

/// 造一个已登录的 AuthController。
///
/// 走真实的 restore() 而不是直接赋字段：ready 状态是 restore 走出来的，
/// 手搓一个 ready 会跳过 token 校验那段，测试就测不到真实路径。
Future<AuthController> readyAuth(
  Future<http.Response> Function(http.Request req) handler,
) async {
  FlutterSecureStorage.setMockInitialValues({
    'server_base_url': 'http://127.0.0.1:7881',
    'auth_token': 'good',
    'auth_username': 'abao',
  });
  final shared = MockClient((req) async {
    // /api/auth/me 在 login 后和每次 refreshMe 都会被调，统一回同一份
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

Map<String, dynamic> _user(
  String id,
  String username,
  String nickname,
  String role,
  String roleLabel, {
  bool disabled = false,
}) => {
  'id': id,
  'username': username,
  'nickname': nickname,
  'role': role,
  'roleLabel': roleLabel,
  'disabled': disabled,
};

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
