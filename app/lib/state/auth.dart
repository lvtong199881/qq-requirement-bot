import 'dart:async';

import 'package:flutter/foundation.dart';

import '../api/client.dart';import '../api/credentials.dart';
import '../api/endpoint_resolver.dart';
import '../api/models.dart';

/// 会话状态。
///
/// 这是一个显式状态机而不是一堆 bool：启动时要先看本地有没有地址、
/// 有没有 token、token 还灵不灵，这三件事的中间态如果不建模，
/// 界面就会闪一下登录页再跳回列表。
enum AuthStage {
  /// 还在读本地凭据
  booting,

  /// 没配服务器地址，只能先去设置页
  needServer,

  /// 配了地址但没登录 / token 过期
  needLogin,

  /// 已登录
  ready,
}

class AuthController extends ChangeNotifier {
  AuthController({CredentialStore? store, ApiClient Function(String baseUrl)? clientFactory, EndpointResolver? endpointResolver})
    : _store = store ?? CredentialStore(),
      _newClient = clientFactory ?? ((url) => ApiClient(baseUrl: url)),
      _resolver = endpointResolver;

  final CredentialStore _store;

  /// 造 client 的方式。测试要能塞假 http.Client，否则 restore/login
  /// 这些分支只能靠打真后端验证——那些恰好是最容易出错的分支
  /// （token 过期该不该踢人、网络错误该不该踢人）。
  final ApiClient Function(String baseUrl) _newClient;

  /// 隧道换址的发现+验证器。null = 没配发现通道，自动换址能力关闭，
  /// 行为退回「连不上就提示」。测试里通常注入带 mock 的实例。
  EndpointResolver? _resolver;

  /// 测试专用：单独替换换址器 / 塞一个现成的 client。
  /// 正常代码不要用——restore/login 自己会管理这两样。
  @visibleForTesting
  void setResolverForTest(EndpointResolver r) => _resolver = r;

  @visibleForTesting
  void attachClientForTest(ApiClient c) => _client = c;

  /// 本机学到的这台后端的指纹（/api/auth/status 首次连接时记下来）。
  /// 换址时用它确认新地址后面还是同一台后端。
  String? instanceId;

  AuthStage stage = AuthStage.booting;
  String baseUrl = '';
  String? token;
  User? user;
  Perms perms = Perms.empty;

  /// 上次成功登录用的用户名，登录页预填，省得每次敲。
  String? lastUsername;

  /// 后端有还没改过密码的预设管理员时，这里是它的账号和密码。
  /// 登录页直接把它写出来——新装好的人拿到地址却不知道用什么登，
  /// 是这套系统最容易卡住的一步。
  String? presetAdmin;
  String? presetPassword;

  /// 上次注册时的提示（比如「你是第一个注册的，已自动成为管理员」）。
  /// 一次性的，显示完由界面清掉。
  String? flashNotice;

  ApiClient? _client;

  /// 已登录时非空。未登录时调用方必须先判 stage。
  ApiClient get client {
    final c = _client;
    if (c == null) throw StateError('还没登录，不该在这时候请求 /api');
    return c;
  }

  bool get hasClient => _client != null;

  /// 启动时恢复。
  ///
  /// 关键点：有 token 也不能直接进首页——token 会过期、账号可能被停用。
  /// 所以拿 /api/auth/me 验一次。验不过就清 token 回登录页，
  /// 而不是留着坏 token 让用户每次操作都 401。
  Future<void> restore() async {
    final creds = await _store.load();
    if (creds == null || creds.baseUrl.isEmpty) {
      stage = AuthStage.needServer;
      notifyListeners();
      return;
    }

    baseUrl = creds.baseUrl;
    lastUsername = creds.username;
    _client = _newClient(baseUrl);
    instanceId = await _store.readInstanceId();

    if (!creds.hasToken) {
      stage = AuthStage.needLogin;
      notifyListeners();
      return;
    }

    _client!.token = creds.token;
    // 字段先落：后面的自动换址要把 token 交给 resolver 去新地址验证，
    // 不然换址永远拿着 null token 被自己的校验拦下。
    token = creds.token;
    try {
      final me = await _client!.me();
      token = creds.token;
      user = me.user;
      perms = me.perms;
      stage = AuthStage.ready;
    } on ApiException catch (e) {
      if (e.isAuth) {
        // 过期或被停用：清掉，回登录页
        await _store.clearToken();
        _client!.token = null;
        token = null;
        stage = AuthStage.needLogin;
      } else if (e.isNetwork || e.statusCode != null && e.statusCode! >= 500) {
        // 网络不通或隧道被回收（5xx）：先试自动换址——
        // 大概率是服务器重启拿了新隧道域名。换成了就直接进首页，
        // 用户感觉不到发生过什么；没换成才退回原来的「保留 token + 可重试」。
        // 注意换不成时**不清 token**：服务器可能只是暂时连不上，
        // 清了等于把「重试就能恢复」变成「必须重新登录」。
        final swapped = await _tryResolveAndSwap();
        if (swapped) {
          try {
            final me = await _client!.me();
            token = creds.token;
            user = me.user;
            perms = me.perms;
            stage = AuthStage.ready;
            notifyListeners();
            return;
          } on ApiException {
            // 换址成功但验证又失败（比如 token 恰好过期）：按过期处理
            await _store.clearToken();
            _client!.token = null;
            stage = AuthStage.needLogin;
          }
        } else {
          token = creds.token;
          _client!.token = creds.token;
          stage = AuthStage.needLogin;
          flashNotice = '无法连接服务器：${e.message}';
        }
      } else {
        // 网络问题不该把用户踢下线——地址和 token 都还是好的，
        // 只是这次没连上。停在登录页但要让人能「重试」。
        token = creds.token;
        _client!.token = creds.token;
        stage = AuthStage.needLogin;
        flashNotice = '无法连接服务器：${e.message}';
      }
    }
    notifyListeners();
  }

  /// 改服务器地址。会清掉 token——换了后端，旧 token 一定无效，
  /// 留着只会让第一次请求 401 然后被误判成「密码错了」。
  Future<void> setServer(String raw) async {
    final url = normalizeBaseUrl(raw);
    if (url.isEmpty) throw ApiException('请填服务器地址，比如 http://192.168.1.10:7881');
    final probe = _newClient(url);
    // 先探一次 /healthz：地址写错时立刻告诉用户，比让他输完账号密码
    // 再看到「连不上」体验好得多。
    String? presetName;
    String? presetPwd;
    try {
      final st = await probe.authStatus();
      presetName = st.presetAdmin;
      presetPwd = st.presetPassword;
    } finally {
      probe.close();
    }

    await _store.clearToken();
    await _store.saveBaseUrl(url);
    baseUrl = url;
    token = null;
    user = null;
    perms = Perms.empty;
    _client = _newClient(url)..token = null;
    presetAdmin = presetName;
    presetPassword = presetPwd;
    // 有预设账号就替用户填好账号名，少打一个字是一个
    if (presetName != null) lastUsername = presetName;
    stage = AuthStage.needLogin;
    notifyListeners();
  }

  Future<void> login({required String username, required String password}) async {
    final c = _requireClient();
    ({String token, User user}) r;
    try {
      r = await c.login(username: username, password: password);
    } on ApiException catch (e) {
      // 登录打的是老地址：如果失败原因是网络级/5xx（隧道被回收），
      // 先试自动换址再原样重试，用户填的还是「那个服务器」，只是域名换了。
      final failoverWorthy = e.isNetwork || (e.statusCode != null && e.statusCode! >= 500);
      if (!failoverWorthy) rethrow;
      final swapped = await _tryResolveAndSwap();
      if (!swapped) rethrow;
      r = await client.login(username: username, password: password);
    }
    await _finishLogin(client, r.token, username);
  }

  Future<void> register({
    required String username,
    required String password,
    String? nickname,
  }) async {
    final c = _requireClient();
    final r = await c.register(username: username, password: password, nickname: nickname);
    await _finishLogin(c, r.token, username);
    if (r.notice.isNotEmpty) flashNotice = r.notice;
  }

  Future<void> _finishLogin(ApiClient c, String tok, String username) async {
    c.token = tok;
    token = tok;
    // 登录响应里的 user 够用，但 perms 只有 /me 给。多一次请求换掉
    // 前端硬编码角色判断，值得。
    final me = await c.me();
    user = me.user;
    perms = me.perms;
    lastUsername = username;
    await _store.saveSession(token: tok, username: username);
    // 登进来了就不再提示初始密码：它可能已被改掉，继续显示会误导
    presetAdmin = null;
    presetPassword = null;
    stage = AuthStage.ready;
    notifyListeners();
    // 顺手记下这台后端的指纹（失败不影响登录本身）。
    unawaited(_learnInstanceId(c));
  }

  Future<void> _learnInstanceId(ApiClient c) async {
    try {
      final st = await c.authStatus();
      if (st.instanceId == null || st.instanceId!.isEmpty) return;
      instanceId = st.instanceId;
      await _store.saveInstanceId(st.instanceId!);
    } on ApiException {
      // 学不到就算了：下次连接再学。换址校验没有指纹时退化为只验 token。
    }
  }

  Future<void> logout() async {
    await _store.clearToken();
    _client?.token = null;
    token = null;
    user = null;
    perms = Perms.empty;
    stage = AuthStage.needLogin;
    notifyListeners();
  }

  /// 静默换址：与 [setServer] 的关键区别是**不清 token、不回 needLogin**。
  ///
  /// 隧道换的只是入口，后端用户表没变，token 依然有效——所以只换
  /// client 和地址，stage 保持 ready，界面连闪都不闪一下。
  /// 换址前 caller（[_tryResolveAndSwap]）已经验证过 instanceId + token。
  Future<bool> swapServerSilently(String url) async {
    final normalized = normalizeBaseUrl(url);
    if (normalized.isEmpty) return false;
    final c = _newClient(normalized)..token = token;
    final old = _client;
    _client = c;
    baseUrl = normalized;
    await _store.saveBaseUrl(normalized);
    old?.close();
    notifyListeners();
    return true;
  }

  /// 走一遍「发现 → 验证 → 静默换址」。成功返回 true。
  /// 没配发现通道、验证不过、全部候选都挂，都返回 false（保持现状）。
  Future<bool> _tryResolveAndSwap() async {
    final r = _resolver;
    if (r == null) return false;
    final url = await r.resolve(knownInstanceId: instanceId ?? '', token: token);
    if (url == null) return false;
    return swapServerSilently(url);
  }

  /// 带自动换址的请求包装：先直接调，网络级失败（连不上/超时/5xx）
  /// 时尝试换址，换成了把同一个请求重试一次。
  ///
  /// 只重试一次：GET 重试天然安全；POST（发消息）在网络异常下请求
  /// 大概率没到达（SocketException 意味着连接都没建立），单次重试
  /// 不会造成重复发送，再多就有风险了。
  Future<T> runWithFailover<T>(Future<T> Function(ApiClient c) fn) async {
    try {
      return await fn(client);
    } on ApiException catch (e) {
      final failoverWorthy = e.isNetwork || (e.statusCode != null && e.statusCode! >= 500);
      if (!failoverWorthy || !hasClient) rethrow;
      final swapped = await _tryResolveAndSwap();
      if (!swapped) rethrow;
      return fn(client);
    }
  }

  /// 别人给我提了权 / 停了号，我这边要能感知。
  Future<void> refreshMe() async {
    if (!hasClient || token == null) return;
    try {
      final me = await client.me();
      user = me.user;
      perms = me.perms;
      notifyListeners();
    } on ApiException catch (e) {
      if (e.isAuth) await logout();
    }
  }

  void consumeNotice() {
    flashNotice = null;
  }

  ApiClient _requireClient() {
    final c = _client;
    if (c == null) throw ApiException('还没有配置服务器地址');
    return c;
  }

  @override
  void dispose() {
    _client?.close();
    super.dispose();
  }
}
