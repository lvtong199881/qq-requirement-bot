import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:qqbot_app/api/client.dart';
import 'package:qqbot_app/api/credentials.dart';
import 'package:qqbot_app/state/auth.dart';

/// 登录状态机的行为。
///
/// 这里钉的是几个「想清楚了才对」的分支，改界面时最容易被顺手改坏：
/// - token 过期 → 清掉、回登录页
/// - token 没到期但网络挂了 → 保留 token，别把用户踢下线
/// - 换服务器 → 必须清 token（旧 token 对新后端一定无效）
///
/// 用假存储 + 假 http.Client，不碰真实网络。
AuthController authWith(
  Future<http.Response> Function(http.Request req) handler,
) {
  final http.Client shared = MockClient(handler);
  return AuthController(
    clientFactory: (url) => ApiClient(baseUrl: url, httpClient: shared),
  );
}

http.Response jsonOk(Map<String, dynamic> body) => http.Response(
  jsonEncode({'ok': true, ...body}),
  200,
  headers: {'content-type': 'application/json; charset=utf-8'},
);

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

void main() {
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));

  test('没配过地址时进 needServer', () async {
    final auth = authWith((_) async => jsonOk({}));
    await auth.restore();
    expect(auth.stage, AuthStage.needServer);
    expect(auth.hasClient, isFalse);
  });

  test('只配了地址、没有 token 时进 needLogin，且用户名预填', () async {
    FlutterSecureStorage.setMockInitialValues({
      'server_base_url': 'http://127.0.0.1:7881',
      'auth_username': 'abao',
    });
    var requests = 0;
    final auth = authWith((_) async {
      requests++;
      return jsonOk(_me);
    });
    await auth.restore();

    expect(auth.stage, AuthStage.needLogin);
    expect(auth.lastUsername, 'abao');
    // 没 token 就不该白跑一次 /me
    expect(requests, 0);
  });

  test('有 token 且有效 → ready，perms 来自 /me 而不是猜角色', () async {
    FlutterSecureStorage.setMockInitialValues({
      'server_base_url': 'http://127.0.0.1:7881',
      'auth_token': 'good',
      'auth_username': 'abao',
    });
    final auth = authWith((req) async {
      expect(req.url.path, '/api/auth/me');
      expect(req.headers['authorization'], 'Bearer good');
      return jsonOk(_me);
    });
    await auth.restore();

    expect(auth.stage, AuthStage.ready);
    expect(auth.user?.displayName, '产品阿宝');
    expect(auth.perms.confirm, isTrue);
    // token 过期时间由后端定，App 只存不解析
    expect(auth.token, 'good');
  });

  test('token 被后端拒（401）→ 清 token 回登录页，不留在坏状态', () async {
    FlutterSecureStorage.setMockInitialValues({
      'server_base_url': 'http://127.0.0.1:7881',
      'auth_token': 'stale',
      'auth_username': 'abao',
    });
    final auth = authWith((_) async => http.Response(
      jsonEncode({'ok': false, 'error': '请先登录'}),
      401,
      headers: {'content-type': 'application/json'},
    ));
    await auth.restore();

    expect(auth.stage, AuthStage.needLogin);
    expect(auth.token, isNull);
    // 关键：坏 token 必须从保险箱里删掉。不删的话下次启动还会拿它试一遍，
    // 用户看到的就是「每次打开都闪一下再回登录页」。
    final saved = await CredentialStore().load();
    expect(saved?.hasToken, isFalse);
    // 地址和用户名要留着，不然用户得从头配一遍
    expect(auth.baseUrl, 'http://127.0.0.1:7881');
    expect(auth.lastUsername, 'abao');
  });

  test('网络挂了不清 token：服务器只是暂时连不上，不该逼人重登', () async {
    FlutterSecureStorage.setMockInitialValues({
      'server_base_url': 'http://127.0.0.1:7881',
      'auth_token': 'good',
      'auth_username': 'abao',
    });
    final auth = authWith((_) async => throw http.ClientException('Connection refused'));
    await auth.restore();

    expect(auth.stage, AuthStage.needLogin);
    expect(auth.token, 'good');
    // 网络错误更不能删：服务器恢复后这次登录还能继续用
    final saved = await CredentialStore().load();
    expect(saved?.hasToken, isTrue);
    // 要告诉用户是网络问题，不是密码错了
    expect(auth.flashNotice, contains('无法连接服务器'));
  });

  test('空地址直接报错，不发请求', () async {
    final auth = authWith((_) async => jsonOk({}));
    await expectLater(auth.setServer('   '), throwsA(isA<ApiException>()));
  });

  test('换服务器会清掉旧 token', () async {
    FlutterSecureStorage.setMockInitialValues({
      'server_base_url': 'http://old:7881',
      'auth_token': 'old-token',
      'auth_username': 'abao',
    });
    final auth = authWith((req) async {
      if (req.url.path == '/api/auth/status') {
        // setServer 探活不该带旧 token：新后端可能根本不认识它
        expect(req.headers['authorization'], isNull);
        return jsonOk({'needsFirstAdmin': false});
      }
      // restore() 先验一次旧 token
      return jsonOk(_me);
    });
    await auth.restore();

    await auth.setServer('new-host:9000');

    expect(auth.baseUrl, 'http://new-host:9000'); // 补了 http，去掉斜杠
    expect(auth.token, isNull);
    expect(auth.stage, AuthStage.needLogin);
  });

  test('换服务器时探测失败要报错，不能把地址写进去', () async {
    FlutterSecureStorage.setMockInitialValues({
      'server_base_url': 'http://old:7881',
    });
    final auth = authWith((_) async => throw http.ClientException('nope'));
    await auth.restore();

    await expectLater(
      auth.setServer('http://wrong:9000'),
      throwsA(isA<ApiException>()),
    );
    // 地址没变，用户能继续用原来的
    expect(auth.baseUrl, 'http://old:7881');
  });

  test('注册时后端给的 notice 会被带出来，显示一次就清掉', () async {
    FlutterSecureStorage.setMockInitialValues({'server_base_url': 'http://127.0.0.1:7881'});
    final auth = authWith((req) async {
      if (req.url.path == '/api/auth/register') {
        return jsonOk({
          'token': 'tk',
          'user': {
            'id': 'u1',
            'username': 'abao',
            'nickname': '阿宝',
            'role': 'admin',
            'roleLabel': '系统管理员',
          },
          'notice': '你是第一个注册的，已自动成为系统管理员',
        });
      }
      return jsonOk(_me);
    });
    await auth.restore();

    await auth.register(username: 'abao', password: 'pass1234');
    expect(auth.stage, AuthStage.ready);
    expect(auth.flashNotice, contains('第一个'));

    auth.consumeNotice();
    expect(auth.flashNotice, isNull);
  });

  test('退出登录清 token 但保留地址和用户名', () async {
    FlutterSecureStorage.setMockInitialValues({
      'server_base_url': 'http://127.0.0.1:7881',
      'auth_token': 'good',
      'auth_username': 'abao',
    });
    final auth = authWith((_) async => jsonOk(_me));
    await auth.restore();
    expect(auth.stage, AuthStage.ready);

    await auth.logout();

    expect(auth.token, isNull);
    expect(auth.user, isNull);
    expect(auth.stage, AuthStage.needLogin);
    expect(auth.baseUrl, 'http://127.0.0.1:7881');
    final saved = await CredentialStore().load();
    expect(saved?.hasToken, isFalse);
  });

  test('未登录时调 client 抛 StateError，而不是拿空 token 打请求', () async {
    final auth = authWith((_) async => jsonOk({}));
    await auth.restore();
    expect(() => auth.client, throwsStateError);
  });
}
