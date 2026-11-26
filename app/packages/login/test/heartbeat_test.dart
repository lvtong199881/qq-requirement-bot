import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:login/login.dart';
import 'package:network/network.dart';

/// 后台心跳换址：地址要在后台持续对齐，不能等请求失败才去找。
///
/// 钉的几条：
/// - 只在已登录（ready）时开心跳；离开 ready（登出）立即关；
/// - 心跳到点会走一次 resolve，而不是等用户操作撞失败；
/// - 没配发现通道（无 resolver）时心跳根本不启动。
///
/// 用假 resolver 计数，不碰真实网络。

class _CountingResolver extends EndpointResolver {
  _CountingResolver() : super(discoveryUrl: 'https://example.invalid/endpoint.json');
  int calls = 0;

  @override
  Future<String?> resolve({required String knownInstanceId, required String? token}) async {
    calls++;
    return null; // 不换址，只计数
  }
}

http.Response _ok(Map<String, dynamic> body) => http.Response(
  jsonEncode({'ok': true, ...body}),
  200,
  headers: {'content-type': 'application/json; charset=utf-8'},
);

const _me = {
  'user': {'id': 'u1', 'username': 'abao', 'nickname': '阿宝', 'role': 'admin', 'roleLabel': '管理员'},
  'can': {'startRequirement': true, 'confirm': true, 'command': true, 'comment': true, 'read': true},
};

void main() {
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));

  test('没配发现通道时心跳不启动（进了 ready 也不拍）', () {
    final auth = AuthController(clientFactory: (u) => ApiClient(baseUrl: u, httpClient: MockClient((_) async => _ok({}))));
    auth.stage = AuthStage.ready;
    auth.notifyListeners();
    expect(auth.heartbeatRunning, isFalse);
    auth.dispose();
  });

  test('未登录（非 ready）时 notifyListeners 不开心跳', () {
    final r = _CountingResolver();
    final auth = AuthController(
      clientFactory: (u) => ApiClient(baseUrl: u, httpClient: MockClient((_) async => _ok({}))),
      endpointResolver: r,
    );
    auth.stage = AuthStage.needLogin;
    auth.notifyListeners();
    expect(auth.heartbeatRunning, isFalse);
    auth.dispose();
  });

  test('进入 ready 后心跳启动，离开 ready 立即关闭', () async {
    final r = _CountingResolver();
    final auth = AuthController(
      clientFactory: (u) => ApiClient(baseUrl: u, httpClient: MockClient((_) async => _ok(_me))),
      endpointResolver: r,
    );
    auth.stage = AuthStage.ready;
    auth.notifyListeners();
    expect(auth.heartbeatRunning, isTrue);

    auth.stage = AuthStage.needLogin;
    auth.notifyListeners();
    expect(auth.heartbeatRunning, isFalse);
    auth.dispose();
  });

  test('一拍心跳会走一次 resolve（不等请求失败才换址）', () async {
    final r = _CountingResolver();
    final auth = AuthController(
      clientFactory: (u) => ApiClient(baseUrl: u, httpClient: MockClient((_) async => _ok(_me))),
      endpointResolver: r,
    );
    auth.stage = AuthStage.ready;
    auth.notifyListeners(); // ready 打开心跳的门
    auth.attachClientForTest(ApiClient(baseUrl: 'https://old.example.com', httpClient: MockClient((_) async => _ok(_me))));
    auth.token = 'tok';
    await auth.beatForTest();
    expect(r.calls, 1);
    auth.dispose();
  });

  test('心跳门控关着（非 ready）时一拍也不走 resolve', () async {
    final r = _CountingResolver();
    final auth = AuthController(
      clientFactory: (u) => ApiClient(baseUrl: u, httpClient: MockClient((_) async => _ok({}))),
      endpointResolver: r,
    );
    auth.attachClientForTest(ApiClient(baseUrl: 'https://old.example.com', httpClient: MockClient((_) async => _ok({}))));
    auth.token = 'tok';
    await auth.beatForTest();
    expect(r.calls, 0, reason: '没登录没有 token，拍也拍不动');
    auth.dispose();
  });
}
