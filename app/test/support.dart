import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:qqbot_app/api/client.dart';
import 'package:qqbot_app/state/auth.dart';

/// 新测试共用的登录态桩：把 secure storage 和服务端响应都换成假的。
///
/// 放在这里而不是每个文件抄一遍 _readyAuth：抄三份之后，
/// 改一下预设账号就要改三处，忘一处就变成「只有一个文件是红的」。
Future<AuthController> readyAuth(
  Future<http.Response> Function(http.Request req) handler,
) async {
  FlutterSecureStorage.setMockInitialValues({
    'server_base_url': 'http://127.0.0.1:7881',
    'auth_token': 'good',
    'auth_username': 'abao',
  });
  final shared = MockClient((req) async {
    if (req.url.path == '/api/auth/me') return ok(me);
    return handler(req);
  });
  final auth = AuthController(
    clientFactory: (url) => ApiClient(baseUrl: url, httpClient: shared),
  );
  await auth.restore();
  assert(auth.stage == AuthStage.ready);
  return auth;
}

http.Response ok(Map<String, dynamic> body) => http.Response(
  jsonEncode({'ok': true, ...body}),
  200,
  headers: {'content-type': 'application/json; charset=utf-8'},
);

http.Response failBody(int status, String error, {String? code}) => http.Response(
  jsonEncode({'ok': false, 'error': error, 'code': ?code}),
  status,
  headers: {'content-type': 'application/json; charset=utf-8'},
);

/// 当前用户：管理员，所以建群/import 权限都是真的
const me = {
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
