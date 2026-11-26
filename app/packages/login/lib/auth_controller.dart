import 'dart:async';

import 'package:flutter/foundation.dart';

import 'package:network/network.dart';

import 'credentials.dart';

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

/// 登录状态机：管「用户是谁、登没登录」。
///
/// 地址怎么换（发现/验证/静默切换/failover/心跳）是 network 的事，
/// 这里只把会话状态翻译成对 [ServerEndpointManager] 的调用，
/// 再在 stage 变化时对齐心跳的开关。
class AuthController extends ChangeNotifier {
  AuthController({
    CredentialStore? store,
    ApiClient Function(String baseUrl)? clientFactory,
    EndpointResolver? endpointResolver,
  }) : _store = store ?? CredentialStore(),
       _manager = ServerEndpointManager(
         resolver: endpointResolver,
         store: store ?? CredentialStore(),
         clientFactory: clientFactory ?? ((url) => ApiClient(baseUrl: url)),
       ) {
    _manager.onSwapped = notifyListeners;
    _manager.beatGate = () => stage == AuthStage.ready;
  }

  final CredentialStore _store;
  final ServerEndpointManager _manager;

  /// 测试专用：单独替换换址器 / 塞一个现成的 client。
  /// 正常代码不要用——restore/login 自己会管理这两样。
  @visibleForTesting
  void setResolverForTest(EndpointResolver r) => _manager.resolver = r;

  @visibleForTesting
  void attachClientForTest(ApiClient c) => _manager.attachClientForTest(c);

  AuthStage stage = AuthStage.booting;
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

  /// 当前服务器地址与实例指纹，真实状态在 manager 里。
  String get baseUrl => _manager.baseUrl;
  set baseUrl(String v) => _manager.baseUrl = v;

  String? get instanceId => _manager.instanceId;
  set instanceId(String? v) => _manager.instanceId = v;

  /// 已登录时非空。未登录时调用方必须先判 stage。
  ApiClient get client => _manager.client;

  bool get hasClient => _manager.hasClient;

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

    lastUsername = creds.username;
    await _manager.attach(creds.baseUrl, token: creds.token);

    if (!creds.hasToken) {
      stage = AuthStage.needLogin;
      notifyListeners();
      return;
    }

    // 字段先落：后面的自动换址要把 token 交给 resolver 去新地址验证，
    // 不然换址永远拿着 null token 被自己的校验拦下。
    token = creds.token;
    try {
      final me = await _manager.client.me();
      token = creds.token;
      user = me.user;
      perms = me.perms;
      stage = AuthStage.ready;
    } on ApiException catch (e) {
      if (e.isAuth) {
        // 过期或被停用：清掉，回登录页
        await _store.clearToken();
        _manager.client.token = null;
        token = null;
        stage = AuthStage.needLogin;
      } else if (e.isNetwork || e.statusCode != null && e.statusCode! >= 500) {
        // 网络不通或隧道被回收（5xx）：先试自动换址——
        // 大概率是服务器重启拿了新隧道域名。换成了就直接进首页，
        // 用户感觉不到发生过什么；没换成才退回原来的「保留 token + 可重试」。
        // 注意换不成时**不清 token**：服务器可能只是暂时连不上，
        // 清了等于把「重试就能恢复」变成「必须重新登录」。
        final swapped = await _manager.tryResolveAndSwap();
        if (swapped) {
          try {
            final me = await _manager.client.me();
            token = creds.token;
            user = me.user;
            perms = me.perms;
            stage = AuthStage.ready;
            notifyListeners();
            return;
          } on ApiException {
            // 换址成功但验证又失败（比如 token 恰好过期）：按过期处理
            await _store.clearToken();
            _manager.client.token = null;
            stage = AuthStage.needLogin;
          }
        } else {
          _keepTokenForRetry(creds.token);
          stage = AuthStage.needLogin;
          flashNotice = '无法连接服务器：${e.message}';
        }
      } else {
        // 网络问题不该把用户踢下线——地址和 token 都还是好的，
        // 只是这次没连上。停在登录页但要让人能「重试」。
        _keepTokenForRetry(creds.token);
        stage = AuthStage.needLogin;
        flashNotice = '无法连接服务器：${e.message}';
      }
    }
    notifyListeners();
  }

  /// 换址没换成时的兜底：token 留在字段和 client 上，
  /// 服务器恢复后这次登录还能直接用。
  void _keepTokenForRetry(String? tok) {
    if (tok == null || tok.isEmpty) return;
    token = tok;
    _manager.client.token = tok;
  }

  /// 改服务器地址。会清掉 token——换了后端，旧 token 一定无效，
  /// 留着只会让第一次请求 401 然后被误判成「密码错了」。
  Future<void> setServer(String raw) async {
    final url = normalizeBaseUrl(raw);
    if (url.isEmpty) throw ApiException('请填服务器地址，比如 http://192.168.1.10:7881');
    final probe = _manager.createClient(url);
    // 先探一次 /auth/status：地址写错时立刻告诉用户，比让他输完账号密码
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
    await _manager.resetServer(url);
    token = null;
    user = null;
    perms = Perms.empty;
    presetAdmin = presetName;
    presetPassword = presetPwd;
    // 有预设账号就替用户填好账号名，少打一个字是一个
    if (presetName != null) lastUsername = presetName;
    stage = AuthStage.needLogin;
    notifyListeners();
  }

  Future<void> login({required String username, required String password}) async {
    _requireClient();
    final r = await _manager.runWithFailover(
      (c) => c.login(username: username, password: password),
    );
    await _finishLogin(r.token, username);
  }

  Future<void> register({
    required String username,
    required String password,
    String? nickname,
  }) async {
    final c = _requireClient();
    final r = await c.register(username: username, password: password, nickname: nickname);
    await _finishLogin(r.token, username);
    if (r.notice.isNotEmpty) flashNotice = r.notice;
  }

  Future<void> _finishLogin(String tok, String username) async {
    final c = _manager.client;
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
    unawaited(_manager.learnInstanceId());
  }

  Future<void> logout() async {
    await _store.clearToken();
    _manager.client.token = null;
    token = null;
    user = null;
    perms = Perms.empty;
    stage = AuthStage.needLogin;
    notifyListeners();
  }

  /// 静默换址：与 [setServer] 的关键区别是**不清 token、不回 needLogin**。
  /// token 平移、地址持久化都在 manager 里。
  Future<bool> swapServerSilently(String url) => _manager.swapServerSilently(url);

  /// 带自动换址的请求包装，转发给 manager（业务侧照旧只用这一个入口）。
  Future<T> runWithFailover<T>(Future<T> Function(ApiClient c) fn) =>
      _manager.runWithFailover(fn);

  /// 测试用：心跳是否在跑、手动触发一拍（不用等 60s 定时器）。
  @visibleForTesting
  bool get heartbeatRunning => _manager.heartbeatRunning;

  @visibleForTesting
  Future<void> beatForTest() => _manager.beatForTest();

  /// 别人给我提了权 / 停了号，我这边要能感知。
  Future<void> refreshMe() async {
    if (!_manager.hasClient || token == null) return;
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
    if (!_manager.hasClient) throw ApiException('还没有配置服务器地址');
    return _manager.client;
  }

  /// 心跳跟着登录态走：每次状态变化都对齐一次——ready 时开，离开 ready 时关。
  /// 放在 notifyListeners 上而不是散落到每个 stage 赋值点，是为了不漏
  /// 任何一条切换路径（restore / login / logout / 换址失效都会走到这里）。
  @override
  void notifyListeners() {
    if (stage == AuthStage.ready) {
      _manager.startHeartbeat();
    } else {
      _manager.stopHeartbeat();
    }
    super.notifyListeners();
  }

  @override
  void dispose() {
    _manager.dispose();
    super.dispose();
  }
}
