import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;

import 'models.dart';

/// 服务端返回的失败。code 来自后端的 error code（如 forbidden），
/// 界面靠它区分「权限不够」和「网络坏了」——这两种要给的提示完全不同。
class ApiException implements Exception {
  ApiException(
    this.message, {
    this.statusCode,
    this.code,
    this.roleLabel,
  });

  final String message;
  final int? statusCode;
  final String? code;
  final String? roleLabel;

  bool get isAuth => statusCode == 401 || statusCode == 403;

  /// 只有 401 才代表「登录态没了」。403 可能是「没加入这个群」，
  /// 那种情况踢人回登录页是错的——人还在，只是这个群没权限。
  bool get isUnauthenticated => statusCode == 401;

  /// 没加入这个群：详情页要据此给出「加入」按钮而不是「重试」
  bool get isNotMember => statusCode == 403 && code == 'not_member';
  bool get isNetwork => statusCode == null;

  @override
  String toString() => message;
}

/// 地址栏友好化：用户可能贴 `http://x.x:7881/` 或者干脆不带协议。
///
/// 不带协议时默认补 http 而不是 https：自建服务大概率没配证书，
/// 补 https 会让第一次配置必然失败，用户又不知道错在哪。
String normalizeBaseUrl(String raw) {
  var s = raw.trim();
  if (s.isEmpty) return '';
  if (!s.startsWith('http://') && !s.startsWith('https://')) {
    s = 'http://$s';
  }
  while (s.endsWith('/')) {
    s = s.substring(0, s.length - 1);
  }
  return s;
}

/// 后端的薄封装。
///
/// 刻意不用代码生成 / 拦截器框架：接口就十几个，手写反而看得清每个
/// 请求到底发了什么，出问题能直接对着 docs/API.md 核。
class ApiClient {
  ApiClient({
    required this.baseUrl,
    http.Client? httpClient,
    this.timeout = const Duration(seconds: 20),
  }) : _http = httpClient ?? http.Client();

  final String baseUrl;
  final http.Client _http;
  final Duration timeout;

  /// 登录后由 AuthController 设置；每次请求带上。
  String? token;

  /// 换服务器地址要重建 client，但测试里会换 http.Client 做 mock。
  ApiClient withBaseUrl(String url) =>
      ApiClient(baseUrl: url, httpClient: _http, timeout: timeout)..token = token;

  Map<String, String> _headers({bool json = true}) => {
    if (json) 'content-type': 'application/json',
    if (token != null) 'authorization': 'Bearer $token',
  };

  Uri _uri(String path, [Map<String, String>? query]) =>
      Uri.parse('$baseUrl$path').replace(queryParameters: query);

  /// 统一发请求 + 解包。
  ///
  /// 所有响应外层都是 `{ok:true,...}`，失败是 `{ok:false,error,code}`；
  /// 这里把它翻成 值 或 ApiException，调用方只关心业务字段。
  Future<Map<String, dynamic>> _send(
    String method,
    String path, {
    Map<String, String>? query,
    Object? body,
  }) async {
    final uri = _uri(path, query);
    late http.Response res;
    try {
      final req = http.Request(method, uri)..headers.addAll(_headers(json: body != null));
      if (body != null) req.body = jsonEncode(body);
      final streamed = await _http.send(req).timeout(timeout);
      res = await http.Response.fromStream(streamed);
    } on TimeoutException {
      throw ApiException('连接超时，检查服务器地址和网络');
    } on SocketException catch (e) {
      throw ApiException('连不上服务器：${e.message}');
    } on http.ClientException catch (e) {
      throw ApiException('请求失败：${e.message}');
    }

    Map<String, dynamic> map;
    try {
      final decoded = jsonDecode(utf8.decode(res.bodyBytes));
      map = (decoded as Map).cast<String, dynamic>();
    } catch (_) {
      // 拿到的不是 JSON，通常是被某个代理拦截了（登录页/验证码页）。
      // 直接把状态码报出来，比一句「解析失败」有用得多。
      throw ApiException(
        res.statusCode >= 400 ? '服务器返回 ${res.statusCode}' : '服务器返回了无法识别的响应',
        statusCode: res.statusCode,
      );
    }

    if (res.statusCode >= 400 || map['ok'] == false) {
      throw ApiException(
        (map['error'] ?? '服务器返回 ${res.statusCode}').toString(),
        statusCode: res.statusCode,
        code: map['code']?.toString(),
        roleLabel: map['roleLabel']?.toString(),
      );
    }
    return map;
  }

  // ── 账号 ──

  /// 服务端有没有账号。true 时注册页要提示「你会成为第一个管理员」。
  /// 首屏状态。除了「要不要引导注册」，还带回预设管理员的账号密码——
  /// 有的话可以直接写在登录页上，省得人去翻安装文档。
  Future<({bool needsFirstAdmin, String? presetAdmin, String? presetPassword})>
  authStatus() async {
    final m = await _send('GET', '/api/auth/status');
    return (
      needsFirstAdmin: m['needsFirstAdmin'] == true,
      presetAdmin: m['presetAdmin'] as String?,
      presetPassword: m['presetPassword'] as String?,
    );
  }

  Future<({String token, User user, String notice})> register({
    required String username,
    required String password,
    String? nickname,
  }) async {
    final m = await _send('POST', '/api/auth/register', body: {
      'username': username,
      'password': password,
      if (nickname != null && nickname.isNotEmpty) 'nickname': nickname,
    });
    return (
      token: m['token'].toString(),
      user: User.fromJson((m['user'] as Map).cast<String, dynamic>()),
      notice: (m['notice'] ?? '').toString(),
    );
  }

  Future<({String token, User user})> login({
    required String username,
    required String password,
  }) async {
    final m = await _send('POST', '/api/auth/login', body: {
      'username': username,
      'password': password,
    });
    return (
      token: m['token'].toString(),
      user: User.fromJson((m['user'] as Map).cast<String, dynamic>()),
    );
  }

  Future<({User user, Perms perms})> me() async {
    final m = await _send('GET', '/api/auth/me');
    return (
      user: User.fromJson((m['user'] as Map).cast<String, dynamic>()),
      perms: Perms.fromJson((m['can'] as Map?)?.cast<String, dynamic>() ?? const {}),
    );
  }

  // ── 需求 ──

  /// 群列表。顺带把 agent 的显示名带回来——App 要拼「@AI员工」，
  /// 名字在服务端配置里，前端不能写死。
  Future<({List<Thread> threads, String? botName})> listThreads() async {
    final m = await _send('GET', '/api/threads');
    final threads = (m['threads'] as List? ?? const [])
        .whereType<Map>()
        .map((e) => Thread.fromJson(e.cast<String, dynamic>()))
        .toList();
    return (threads: threads, botName: m['botName']?.toString());
  }

  /// 建群。只给一个名字：需求不在这一步提，@ 需求 bot 才开跑。
  Future<Thread> createGroup(String name) async {
    final m = await _send('POST', '/api/threads', body: {'name': name});
    final raw = m['thread'];
    if (raw is! Map) {
      // 后端一定会回完整形状；真缺了就按 threadId 给个最小可用对象，
      // 别让用户建完群看到一片空白。
      return Thread(threadId: m['threadId'].toString(), groupName: name, pending: true);
    }
    return Thread.fromJson(raw.cast<String, dynamic>());
  }

  Future<Thread> thread(String threadId) async {
    final m = await _send('GET', '/api/threads/${Uri.encodeComponent(threadId)}');
    return Thread.fromJson((m['thread'] as Map).cast<String, dynamic>());
  }

  /// 按群号查群：只知道群号的人也能看到「叫什么、几个人」，
  /// 但看不到消息。用来做搜索加入前的确认。
  Future<GroupPreview> groupPreview(String threadId) async {
    final m = await _send('GET', '/api/threads/${Uri.encodeComponent(threadId)}/preview');
    return GroupPreview.fromJson((m['preview'] as Map).cast<String, dynamic>());
  }

  /// 加入群。幂等：已经在群里时 joined 为 false，但不算失败。
  Future<({bool joined, Thread? thread})> joinGroup(String threadId) async {
    final m = await _send('POST', '/api/threads/${Uri.encodeComponent(threadId)}/join');
    final raw = m['thread'];
    return (
      joined: m['joined'] == true,
      thread: raw is Map ? Thread.fromJson(raw.cast<String, dynamic>()) : null,
    );
  }

  /// 群成员 + 我的权限。
  Future<GroupMembers> groupMembers(String threadId) async {
    final m = await _send('GET', '/api/threads/${Uri.encodeComponent(threadId)}/members');
    return GroupMembers.fromJson(m);
  }

  /// 改群名（系统管理员或群管理员）。
  Future<Thread> renameGroup(String threadId, String name) async {
    final m = await _send(
      'PATCH',
      '/api/threads/${Uri.encodeComponent(threadId)}',
      body: {'name': name},
    );
    return Thread.fromJson((m['thread'] as Map).cast<String, dynamic>());
  }

  /// 群主指定/取消群管理员。
  Future<List<GroupMember>> setMemberRole(String threadId, String userId, String role) async {
    final m = await _send(
      'POST',
      '/api/threads/${Uri.encodeComponent(threadId)}/members/${Uri.encodeComponent(userId)}/role',
      body: {'role': role},
    );
    return (m['members'] as List? ?? const [])
        .whereType<Map>()
        .map((e) => GroupMember.fromJson(e.cast<String, dynamic>()))
        .toList();
  }

  /// 增量拉消息。
  ///
  /// 用 since 而不是整页：详情页每 3 秒轮询一次，整页拉在长会话上
  /// 既费流量又会让列表滚动位置跟着抖。since=0 表示要全量。
  Future<({List<Message> messages, int lastSeq})> messages(
    String threadId, {
    int since = 0,
    int limit = 200,
  }) async {
    final m = await _send(
      'GET',
      '/api/threads/${Uri.encodeComponent(threadId)}/messages',
      query: {'since': '$since', 'limit': '$limit'},
    );
    return (
      messages: (m['messages'] as List? ?? const [])
          .whereType<Map>()
          .map((e) => Message.fromJson(e.cast<String, dynamic>()))
          .toList(),
      lastSeq: (m['lastSeq'] as num?)?.toInt() ?? 0,
    );
  }

  /// 发一条消息。
  ///
  /// mentions 是「这句话提到了谁」：@ 了需求 bot 的那句才会开需求。
  /// 服务端也会从文本里认手打的「@名字」，但显式传更准
  /// （bot 名字可配置，文本里不一定是同一个名字）。
  Future<void> sendMessage(
    String threadId,
    String text, {
    List<String> mentions = const [],
    List<MessageAnswer> answers = const [],
    int? askSeq,
  }) => _send(
    'POST',
    '/api/threads/${Uri.encodeComponent(threadId)}/messages',
    body: {
      'text': text,
      if (mentions.isNotEmpty) 'mentions': mentions,
      // 提问卡片上点「提交」：勾选结果原样发回去，引擎按 q1..qN 对位还原，
      // 比让用户手打「1B 2A」可靠得多
      if (answers.isNotEmpty) 'answers': answers.map((a) => a.toJson()).toList(),
      'askSeq': ?askSeq,
    },
  );

  /// 需求引擎连没连上。
  ///
  /// 返回 null 表示无从判断：这台服务器没有可查的引擎通道（单机部署时引擎就在
  /// 同一个进程里，或者没配密钥），或者引擎从没连上来过（纯聊天部署）。
  /// 那种情况下不该提示「引擎没连上」——对用户来说并没有第二个东西需要连。
  Future<bool?> engineOnline() async {
    try {
      final m = await _send('GET', '/api/engine/status');
      final online = m['online'];
      if (online is! bool) return null;
      return online;
    } on ApiException catch (e) {
      if (e.statusCode == 404 || e.statusCode == 503) return null;
      rethrow;
    }
  }

  Future<void> approve(String threadId) => _send(
    'POST',
    '/api/threads/${Uri.encodeComponent(threadId)}/approve',
  );

  Future<void> reject(String threadId, String reason) => _send(
    'POST',
    '/api/threads/${Uri.encodeComponent(threadId)}/reject',
    body: {'reason': reason},
  );

  // ── 账号管理（只有系统管理员能调，后端会拒其他人） ──

  Future<List<User>> listUsers() async {
    final m = await _send('GET', '/api/users');
    return (m['users'] as List? ?? const [])
        .whereType<Map>()
        .map((e) => User.fromJson(e.cast<String, dynamic>()))
        .toList();
  }

  Future<void> setUserRole(String id, String role) => _send(
    'POST',
    '/api/users/${Uri.encodeComponent(id)}/role',
    body: {'role': role},
  );

  Future<void> setUserDisabled(String id, bool disabled) => _send(
    'POST',
    '/api/users/${Uri.encodeComponent(id)}/disabled',
    body: {'disabled': disabled},
  );

  Future<void> resetUserPassword(String id, String password) => _send(
    'POST',
    '/api/users/${Uri.encodeComponent(id)}/password',
    body: {'password': password},
  );

  /// 产物下载要带 token，而 Image.network / 浏览器下载不会带 header。
  /// 所以这里自己取字节，界面只负责显示或保存。
  Future<List<int>> artifactBytes(String urlPath) async {
    final uri = urlPath.startsWith('http') ? Uri.parse(urlPath) : _uri(urlPath);
    late http.Response res;
    try {
      final req = http.Request('GET', uri)..headers.addAll(_headers(json: false));
      final streamed = await _http.send(req).timeout(timeout);
      res = await http.Response.fromStream(streamed);
    } on TimeoutException {
      throw ApiException('下载超时');
    } on SocketException catch (e) {
      throw ApiException('下载失败：${e.message}');
    }
    if (res.statusCode >= 400) {
      throw ApiException('下载失败（${res.statusCode}）', statusCode: res.statusCode);
    }
    return res.bodyBytes;
  }

  void close() => _http.close();
}
