import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:test/test.dart';
import 'package:network/network.dart';

/// 造一个返回固定 JSON 的假后端。
///
/// 用 http 自带的 MockClient 而不是往 ApiClient 里塞接口：
/// 这样测的是真实的请求构造（URL、query、header、body），
/// 而不是一个我自己定义、和实现同源的假协议。
ApiClient clientWith(
  Future<http.Response> Function(http.Request req) handler, {
  String? token,
}) {
  final c = ApiClient(
    baseUrl: 'http://example.test',
    httpClient: MockClient(handler),
  );
  c.token = token;
  return c;
}

http.Response jsonOk(Map<String, dynamic> body) => http.Response(
  jsonEncode({'ok': true, ...body}),
  200,
  headers: {'content-type': 'application/json; charset=utf-8'},
);

http.Response jsonFail(int code, String error, {String? errCode, String? roleLabel}) =>
    http.Response(
      jsonEncode({
        'ok': false,
        'error': error,
        'code': ?errCode,
        'roleLabel': ?roleLabel,
      }),
      code,
      headers: {'content-type': 'application/json; charset=utf-8'},
    );

void main() {
  group('normalizeBaseUrl', () {
    test('不带协议时补 http 而不是 https', () {
      // 自建服务大概率没证书，猜 https 会让第一次配置必然失败
      expect(normalizeBaseUrl('192.168.1.10:7881'), 'http://192.168.1.10:7881');
    });

    test('保留用户手写的 https', () {
      expect(normalizeBaseUrl('https://x.trycloudflare.com'), 'https://x.trycloudflare.com');
    });

    test('去掉末尾斜杠', () {
      expect(normalizeBaseUrl('http://a.com:7881///'), 'http://a.com:7881');
    });

    test('去首尾空格', () {
      expect(normalizeBaseUrl('  http://a.com  '), 'http://a.com');
    });

    test('空串归一成空串，交给调用方报错', () {
      expect(normalizeBaseUrl('   '), '');
    });
  });

  group('models 容错解析', () {
    test('Thread 缺字段不抛异常，退化成默认值', () {
      final t = Thread.fromJson({'threadId': 'tabc'});
      expect(t.threadId, 'tabc');
      expect(t.name, isNull);
      expect(t.turn, 0);
      expect(t.needsMe, isFalse);
      expect(t.stages, isEmpty);
      // 没有 name 时有兜底标题，界面不会显示空白
      expect(t.title, '未命名群');
      expect(t.pending, isFalse);
    });

    test('Thread 解析完整字段', () {
      final t = Thread.fromJson({
        'threadId': 't1',
        'name': '加个弹窗',
        'stage': '需求澄清',
        'stageStatus': '等你确认',
        'needsMe': true,
        'lastSeq': 7,
        'canAct': true,
        'initiator': {'userId': 'u1', 'nickname': '阿宝'},
        'stages': [
          {'name': '需求澄清', 'status': '等待确认'},
          {'name': '需求定稿', 'status': '未开始'},
        ],
      });
      expect(t.needsMe, isTrue);
      expect(t.lastSeq, 7);
      expect(t.canAct, isTrue);
      expect(t.initiator?.label, '阿宝');
      expect(t.stages.length, 2);
      expect(t.stages.first.active, isTrue);
      expect(t.stages.last.done, isFalse);
    });

    test('Stage 同时认「等待确认」和「等你确认」两种措辞', () {
      expect(const Stage(name: 'x', status: '等待确认').active, isTrue);
      expect(const Stage(name: 'x', status: '等你确认').active, isTrue);
      expect(const Stage(name: 'x', status: '卡住').blocked, isTrue);
      expect(const Stage(name: 'x', status: '阻塞').blocked, isTrue);
      expect(const Stage(name: 'x', status: '未开始').active, isFalse);
    });

    test('Actor 昵称为空时退化用 userId', () {
      final a = Actor.fromJson({'userId': 'u9', 'nickname': ''});
      expect(a.label, 'u9');
    });

    test('Message 的 payload 缺失时不崩', () {
      final m = Message.fromJson({'seq': 3, 'at': 1000, 'role': 'bot', 'kind': 'text'});
      expect(m.seq, 3);
      expect(m.text, '');
      expect(m.artifactUrl, isNull);
    });

    test('User.isAdmin 只认 admin', () {
      expect(User.fromJson({'id': '1', 'role': 'admin'}).isAdmin, isTrue);
      expect(User.fromJson({'id': '1', 'role': 'member'}).isAdmin, isFalse);
      expect(User.fromJson({'id': '1'}).isAdmin, isFalse);
    });
  });

  group('ApiClient 请求构造', () {
    test('登录把 body 编码成 JSON 并返回 token 与 user', () async {
      late http.Request seen;
      final c = clientWith((req) async {
        seen = req;
        return jsonOk({
          'token': 'tok-1',
          'user': {'id': 'u1', 'username': 'abao', 'nickname': '阿宝', 'role': 'admin', 'roleLabel': '系统管理员'},
        });
      });

      final r = await c.login(username: 'abao', password: 'pass1234');

      expect(seen.method, 'POST');
      expect(seen.url.path, '/api/auth/login');
      expect(jsonDecode(seen.body), {'username': 'abao', 'password': 'pass1234'});
      expect(r.token, 'tok-1');
      expect(r.user.displayName, '阿宝');
      expect(r.user.isAdmin, isTrue);
    });

    test('有 token 时带 Authorization 头，没有时不带', () async {
      String? withTok;
      String? without;
      await clientWith((req) async {
        withTok = req.headers['authorization'];
        return jsonOk({'threads': []});
      }, token: 'abc').listThreads();
      // header 名可能被规范化成小写，用 containsKey 兼容
      expect(withTok, 'Bearer abc');

      await clientWith((req) async {
        without = req.headers['authorization'];
        return jsonOk({'threads': []});
      }).listThreads();
      expect(without, isNull);
    });

    test('messages 用 since/limit 做增量拉取', () async {
      late Uri seen;
      final c = clientWith((req) async {
        seen = req.url;
        return jsonOk({'messages': [], 'lastSeq': 42});
      });

      final page = await c.messages('t1', since: 7, limit: 50);

      expect(seen.path, '/api/threads/t1/messages');
      expect(seen.queryParameters, {'since': '7', 'limit': '50'});
      expect(page.lastSeq, 42);
    });

    test('threadId 里的特殊字符会被转义进 URL', () async {
      late Uri seen;
      final c = clientWith((req) async {
        seen = req.url;
        return jsonOk({'thread': {'threadId': 'a/b'}});
      });
      await c.thread('a/b');
      // 不转义就会变成两个路径段，打到不存在的路由
      expect(seen.path, '/api/threads/a%2Fb');
    });

    test('startRequirement 的参数全在 body，路径只放资源', () async {
      late http.Request seen;
      final c = clientWith((req) async {
        seen = req;
        return jsonOk({'ok': true, 'reqId': 'r1', 'name': '首页改版'});
      });
      await c.startRequirement(
        threadId: 't1',
        text: '加一个返回顶部的按钮',
        name: '返回顶部',
        repoId: 'app',
      );
      // 路径不带任何参数：新接口的约定是「路径只放资源标识」
      expect(seen.url.path, '/api/requirements');
      expect(jsonDecode(seen.body), {
        'threadId': 't1',
        'text': '加一个返回顶部的按钮',
        'name': '返回顶部',
        'repoId': 'app',
      });
    });

    test('startRequirement 没填名称时 body 里不带 name 字段', () async {
      late http.Request seen;
      final c = clientWith((req) async {
        seen = req;
        return jsonOk({'ok': true});
      });
      await c.startRequirement(threadId: 't1', text: '随便做点什么', repoId: 'app');
      expect(jsonDecode(seen.body), {
        'threadId': 't1',
        'text': '随便做点什么',
        'repoId': 'app',
      });
    });

    test('listRepos 读 GET /api/repos，容错缺字段', () async {
      late http.Request seen;
      final c = clientWith((req) async {
        seen = req;
        return jsonOk({
          'repos': [
            {'id': 'app', 'name': 'DoDroidAI', 'platform': 'android'},
            {'id': 'hm'},
          ],
        });
      });
      final repos = await c.listRepos();
      expect(seen.url.path, '/api/repos');
      expect(repos.map((r) => r.id), ['app', 'hm']);
      expect(repos.first.name, 'DoDroidAI');
      // 缺字段退回默认平台，界面上不至于显示空白
      expect(repos.last.platform, 'android');
    });

    test('createGroup 发 name，返回空群形状', () async {
      late http.Request seen;
      final c = clientWith((req) async {
        seen = req;
        return jsonOk({
          'threadId': 'tnew',
          'thread': {
            'threadId': 'tnew',
            'groupName': '首页改版',
            'pending': true,
            'stageStatus': '待提需求',
          },
        });
      });
      final t = await c.createGroup('首页改版');
      // 建群只送群名：需求是进去说的第一句话，不在建群时提交
      expect(seen.url.path, '/api/threads');
      expect(jsonDecode(seen.body), {'name': '首页改版'});
      expect(t.threadId, 'tnew');
      expect(t.groupName, '首页改版');
      expect(t.pending, isTrue);
      expect(t.stageStatus, '待提需求');
      // 还没有需求名时，列表标题退到群名，不能显示空白
      expect(t.title, '首页改版');
    });

    test('createGroup 后端没回 thread 时退化成最小对象，不崩', () async {
      final c = clientWith((req) async => jsonOk({'threadId': 'tx'}));
      final t = await c.createGroup('新群');
      expect(t.threadId, 'tx');
      expect(t.groupName, '新群');
      expect(t.pending, isTrue);
      expect(t.stages, isEmpty);
    });
  });

  group('ApiClient 错误映射', () {
    test('403 带 code 时抛 ApiException，isAuth 为真', () async {
      final c = clientWith((req) async =>
          jsonFail(403, '通过和打回只有系统管理员能操作', errCode: 'forbidden', roleLabel: '普通成员'));

      await expectLater(
        c.startRequirement(threadId: 't1', text: '加个按钮', repoId: 'app'),
        throwsA(isA<ApiException>()
            .having((e) => e.message, 'message', '通过和打回只有系统管理员能操作')
            .having((e) => e.code, 'code', 'forbidden')
            .having((e) => e.roleLabel, 'roleLabel', '普通成员')
            .having((e) => e.isAuth, 'isAuth', isTrue)),
      );
    });

    test('401 也算认证类失败，界面据此踢回登录页', () async {
      final c = clientWith((req) async => jsonFail(401, '请先登录'));
      await expectLater(
        c.listThreads(),
        throwsA(isA<ApiException>().having((e) => e.isAuth, 'isAuth', isTrue)),
      );
    });

    test('400 不算认证失败', () async {
      final c = clientWith((req) async => jsonFail(400, '需求内容是空的'));
      await expectLater(
        c.startRequirement(threadId: 't1', text: '', repoId: 'app'),
        throwsA(isA<ApiException>().having((e) => e.isAuth, 'isAuth', isFalse)),
      );
    });

    test('返回 HTML（被代理拦了）时报状态码而不是解析错误', () async {
      final c = clientWith((req) async => http.Response('<html>login</html>', 502));
      await expectLater(
        c.listThreads(),
        throwsA(isA<ApiException>()
            .having((e) => e.message, 'message', '服务器返回 502')
            .having((e) => e.isNetwork, 'isNetwork', isFalse)),
      );
    });

    test('连接失败时 isNetwork 为真，用来区分「网络坏了」和「权限不够」', () async {
      final c = clientWith((req) async => throw http.ClientException('Connection refused'));
      await expectLater(
        c.listThreads(),
        throwsA(isA<ApiException>().having((e) => e.isNetwork, 'isNetwork', isTrue)),
      );
    });
  });

  group('artifactBytes', () {
    test('相对 url 拼到 baseUrl 上并带 token', () async {
      late http.Request seen;
      final c = clientWith((req) async {
        seen = req;
        return http.Response.bytes([1, 2, 3], 200);
      }, token: 'tk');

      final bytes = await c.artifactBytes('/api/threads/t1/artifacts/a1');

      expect(seen.url.toString(), 'http://example.test/api/threads/t1/artifacts/a1');
      expect(seen.headers['authorization'], 'Bearer tk');
      expect(bytes, [1, 2, 3]);
    });

    test('404 时抛异常而不是返回空字节', () async {
      final c = clientWith((req) async => http.Response('', 404));
      await expectLater(
        c.artifactBytes('/api/threads/t1/artifacts/x'),
        throwsA(isA<ApiException>()),
      );
    });
  });
}
