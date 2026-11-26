import 'dart:async';

import 'package:network/network.dart';
import 'package:test/test.dart';

class _MemoryStore implements EndpointStore {
  final Map<String, String> values = {};

  @override
  Future<String?> readBaseUrl() async => values['base_url'];
  @override
  Future<void> saveBaseUrl(String url) async => values['base_url'] = url;
  @override
  Future<String?> readInstanceId() async => values['instance_id'];
  @override
  Future<void> saveInstanceId(String id) async => values['instance_id'] = id;
}

class _CountingResolver extends EndpointResolver {
  _CountingResolver() : super(discoveryUrl: 'https://example.invalid/endpoint.json');

  int resolveCalls = 0;
  String? nextUrl;

  @override
  Future<String?> resolve({String knownInstanceId = '', String? token}) async {
    resolveCalls++;
    return nextUrl;
  }
}

void main() {
  group('ServerEndpointManager', () {
    test('没有配 resolver 时换址与心跳都关着', () {
      final m = ServerEndpointManager();
      expect(m.resolver, isNull);
      m.startHeartbeat();
      expect(m.heartbeatRunning, isFalse);
      expect(m.tryResolveAndSwap(), completion(isFalse));
      m.dispose();
    });

    test('swapServerSilently 平移 token、持久化地址、回调通知', () async {
      final store = _MemoryStore();
      final swapped = <String>[];
      final m = ServerEndpointManager(store: store, clientFactory: (u) => ApiClient(baseUrl: u));
      await m.attach('http://old:7881', token: 'tok');
      m.onSwapped = () => swapped.add(m.baseUrl);

      final ok = await m.swapServerSilently('http://new:7881/');
      expect(ok, isTrue);
      expect(m.baseUrl, 'http://new:7881');
      expect(m.client.token, 'tok', reason: 'token 必须平移，静默换址不断会话');
      expect(store.values['base_url'], 'http://new:7881');
      expect(swapped, ['http://new:7881']);
      m.dispose();
    });

    test('swapServerSilently 拒绝空地址', () async {
      final m = ServerEndpointManager();
      await m.attach('http://old:7881');
      expect(await m.swapServerSilently('   '), isFalse);
      expect(m.baseUrl, 'http://old:7881');
      m.dispose();
    });

    test('runWithFailover：网络错误换址成功后重试一次', () async {
      final m = ServerEndpointManager(clientFactory: (u) => ApiClient(baseUrl: u));
      await m.attach('http://old:7881');
      m.nextResolverForTest(_CountingResolver()..nextUrl = 'http://new:7881');

      var calls = 0;
      final result = await m.runWithFailover((c) async {
        calls++;
        if (calls == 1) {
          throw ApiException('连不上服务器');
        }
        return 'ok-${c.baseUrl}';
      });
      expect(result, 'ok-http://new:7881');
      expect(calls, 2, reason: '只重试一次');
      expect(m.baseUrl, 'http://new:7881');
      m.dispose();
    });

    test('runWithFailover：4xx 业务错误不换址直接抛', () async {
      final m = ServerEndpointManager(clientFactory: (u) => ApiClient(baseUrl: u));
      await m.attach('http://old:7881');
      m.nextResolverForTest(_CountingResolver());

      await expectLater(
        m.runWithFailover<void>((c) async => throw ApiException('没有权限', statusCode: 403)),
        throwsA(isA<ApiException>()),
      );
      expect(m.baseUrl, 'http://old:7881', reason: '业务错误不该触发换址');
      m.dispose();
    });

    test('runWithFailover：换址没成功时原样抛出', () async {
      final m = ServerEndpointManager(clientFactory: (u) => ApiClient(baseUrl: u));
      await m.attach('http://old:7881');
      m.nextResolverForTest(_CountingResolver()); // resolve 返回 null

      await expectLater(
        m.runWithFailover<void>((c) async => throw ApiException('连不上服务器')),
        throwsA(isA<ApiException>()),
      );
      m.dispose();
    });

    test('心跳：门控 false 时跳过，true 时拍', () async {
      final r = _CountingResolver();
      final m = ServerEndpointManager(clientFactory: (u) => ApiClient(baseUrl: u));
      await m.attach('http://old:7881');
      m.nextResolverForTest(r);
      m.beatGate = () => false;

      await m.beatForTest();
      expect(r.resolveCalls, 0, reason: '门关着，不该拍');

      m.beatGate = () => true;
      await m.beatForTest();
      expect(r.resolveCalls, 1);
      m.dispose();
    });

    test('心跳：换址成功走 swap 分支', () async {
      final r = _CountingResolver()..nextUrl = 'http://new:7881';
      final store = _MemoryStore();
      final m = ServerEndpointManager(store: store, clientFactory: (u) => ApiClient(baseUrl: u));
      await m.attach('http://old:7881', token: 'tok');
      m.nextResolverForTest(r);

      await m.beatForTest();
      expect(m.baseUrl, 'http://new:7881');
      expect(store.values['base_url'], 'http://new:7881');
      m.dispose();
    });

    test('resetServer 重建 client 且不带 token，地址持久化', () async {
      final store = _MemoryStore();
      final m = ServerEndpointManager(store: store, clientFactory: (u) => ApiClient(baseUrl: u));
      await m.attach('http://old:7881', token: 'tok');

      await m.resetServer('http://other:7881');
      expect(m.baseUrl, 'http://other:7881');
      expect(m.client.token, isNull, reason: '换服务器（手动）必须清 token');
      expect(store.values['base_url'], 'http://other:7881');
      m.dispose();
    });

    test('attach 恢复 instanceId', () async {
      final store = _MemoryStore()..values['instance_id'] = 'inst-1';
      final m = ServerEndpointManager(store: store, clientFactory: (u) => ApiClient(baseUrl: u));
      await m.attach('http://old:7881');
      expect(m.instanceId, 'inst-1');
      m.dispose();
    });
  });
}
