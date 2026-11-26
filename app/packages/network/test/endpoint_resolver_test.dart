import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:network/network.dart';
import 'package:test/test.dart';

/// 发现通道 + 候选验证的协议行为。
///
/// 这套机制唯一的安全底座就是「instanceId 一致 + token 过验」，
/// 测试钉住的是：什么情况下允许换、什么情况下宁可不动。
http.Response jsonOk(Map<String, dynamic> body) => http.Response(
  jsonEncode({'ok': true, ...body}),
  200,
  headers: {'content-type': 'application/json; charset=utf-8'},
);

void main() {
  test('发现文件解析：urls 去重 + 丢弃非 http 项', () async {
    late http.Request captured;
    final resolver = EndpointResolver(
      discoveryUrl: 'https://discovery/endpoint.json',
      httpClient: MockClient((req) async {
        // 发现文件里故意混了重复项和 ftp 项，看解析层能不能洗掉。
        if (req.url.host == 'discovery') {
          return http.Response(jsonEncode({
            'instanceId': 'inst_a',
            'urls': [
              'https://new.example.com',
              'https://old.example.com/',
              'https://new.example.com',
              'ftp://weird',
            ],
          }), 200);
        }
        captured = req;
        if (req.url.host != 'new.example.com') {
          fail('候选验证应该停在第一个通过项，实际探到了 ${req.url.host}');
        }
        if (req.url.path == '/healthz') return jsonOk({});
        return jsonOk({
          'user': {'id': 'u1'},
          'can': {},
        });
      }),
    );
    final url = await resolver.resolve(knownInstanceId: 'inst_a', token: 'tk');
    expect(url, 'https://new.example.com');
    // captured 停在第一个候选的带 token 验证上：解析出的干净列表让流程
    // 在 new.example.com 就成功收尾，不会去探 old/ftp。
    expect(captured.url.toString(), 'https://new.example.com/api/auth/me');
  });

  test('instanceId 不一致：拒绝换址（防被指到假冒后端）', () async {
    final resolver = EndpointResolver(
      discoveryUrl: 'https://discovery/endpoint.json',
      httpClient: MockClient((req) async {
        if (req.url.host == 'discovery') {
          return http.Response(
            jsonEncode({'instanceId': 'inst_OTHER', 'urls': ['https://evil.example.com']}),
            200,
          );
        }
        // 任何探活都不该发生
        fail('instanceId 不一致时不应发出探活请求');
      }),
    );
    final url = await resolver.resolve(knownInstanceId: 'inst_mine', token: 'tk');
    expect(url, isNull);
    expect(resolver.cooling, isTrue);
  });

  test('候选 healthz 通了但 token 验不过：换下一候选，全挂进冷却', () async {
    final probed = <String>[];
    final resolver = EndpointResolver(
      discoveryUrl: 'https://discovery/endpoint.json',
      httpClient: MockClient((req) async {
        if (req.url.host == 'discovery') {
          return http.Response(
            jsonEncode({
              'instanceId': 'inst_a',
              'urls': ['https://a.example.com', 'https://b.example.com'],
            }),
            200,
          );
        }
        probed.add(req.url.toString());
        if (req.url.path == '/healthz') return jsonOk({});
        // /api/auth/me 一律 401（token 对不上）；中文 body 要走 Latin1
        // 安全的编码路径，http.Response(String) 默认用 latin1 编码字符串。
        return http.Response('{"ok":false,"error":"unauthorized"}', 401);
      }),
    );
    final url = await resolver.resolve(knownInstanceId: 'inst_a', token: 'tk');
    expect(url, isNull);
    expect(probed.length, 4); // 两个候选 × (healthz + me)
    expect(resolver.cooling, isTrue);
  });

  test('第二个候选全过：返回它', () async {
    final resolver = EndpointResolver(
      discoveryUrl: 'https://discovery/endpoint.json',
      httpClient: MockClient((req) async {
        if (req.url.host == 'discovery') {
          return http.Response(
            jsonEncode({
              'instanceId': 'inst_a',
              'urls': ['https://dead.example.com', 'https://alive.example.com'],
            }),
            200,
          );
        }
        if (req.url.host == 'dead.example.com') throw http.ClientException('refused');
        if (req.url.path == '/healthz') return jsonOk({});
        return jsonOk({
          'user': {'id': 'u1'},
          'can': {},
        });
      }),
    );
    final url = await resolver.resolve(knownInstanceId: 'inst_a', token: 'tk');
    expect(url, 'https://alive.example.com');
    expect(resolver.cooling, isFalse);
  });

  test('发现通道本身挂了：立刻冷却，不抛异常', () async {
    final resolver = EndpointResolver(
      discoveryUrl: 'https://discovery/endpoint.json',
      httpClient: MockClient((req) async => throw http.ClientException('refused')),
    );
    final url = await resolver.resolve(knownInstanceId: 'inst_a', token: 'tk');
    expect(url, isNull);
    expect(resolver.cooling, isTrue);
  });

  test('冷却期内不再发任何请求', () async {
    var calls = 0;
    final resolver = EndpointResolver(
      discoveryUrl: 'https://discovery/endpoint.json',
      httpClient: MockClient((req) async {
        calls++;
        return http.Response('oops', 500);
      }),
    );
    await resolver.resolve(knownInstanceId: 'inst_a', token: 'tk');
    final afterFirst = calls;
    final url = await resolver.resolve(knownInstanceId: 'inst_a', token: 'tk');
    expect(url, isNull);
    expect(calls, afterFirst); // 一次都没多打
  });

  test('没有本地指纹时退化为只验 token', () async {
    final resolver = EndpointResolver(
      discoveryUrl: 'https://discovery/endpoint.json',
      httpClient: MockClient((req) async {
        if (req.url.host == 'discovery') {
          return http.Response(
            jsonEncode({'instanceId': 'inst_a', 'urls': ['https://new.example.com']}),
            200,
          );
        }
        if (req.url.path == '/healthz') return jsonOk({});
        return jsonOk({
          'user': {'id': 'u1'},
          'can': {},
        });
      }),
    );
    final url = await resolver.resolve(knownInstanceId: '', token: 'tk');
    expect(url, 'https://new.example.com');
  });

  test('Gitee contents API 形态：base64 content 解包后照常解析', () async {
    final plain = jsonEncode({
      'instanceId': 'inst_a',
      'urls': ['https://new.example.com'],
    });
    final resolver = EndpointResolver(
      discoveryUrl: 'https://gitee.com/api/v5/repos/o/r/contents/endpoint.json',
      httpClient: MockClient((req) async {
        // gitee API 返回的是 {encoding: base64, content: ...} 包装，
        // 不是裸 endpoint JSON
        if (req.url.host == 'gitee.com') {
          return http.Response(
            jsonEncode({
              'type': 'file',
              'encoding': 'base64',
              'content': base64Encode(utf8.encode(plain)),
            }),
            200,
          );
        }
        if (req.url.path == '/healthz') return jsonOk({});
        return jsonOk({
          'user': {'id': 'u1'},
          'can': {},
        });
      }),
    );
    final url = await resolver.resolve(knownInstanceId: 'inst_a', token: 'tk');
    expect(url, 'https://new.example.com');
  });

  test('Gitee API 形态但 content 是坏 base64：返回 null 进冷却，不炸', () async {
    final resolver = EndpointResolver(
      discoveryUrl: 'https://gitee.com/api/v5/repos/o/r/contents/endpoint.json',
      httpClient: MockClient((req) async {
        return http.Response(
          jsonEncode({'encoding': 'base64', 'content': '!!!not-base64!!!'}),
          200,
        );
      }),
    );
    final url = await resolver.resolve(knownInstanceId: 'inst_a', token: 'tk');
    expect(url, isNull);
    expect(resolver.cooling, isTrue);
  });
}
