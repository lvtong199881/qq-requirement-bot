import 'package:flutter/foundation.dart';

import '../api/client.dart';
import '../api/credentials.dart';
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
  AuthController({CredentialStore? store, ApiClient Function(String baseUrl)? clientFactory})
    : _store = store ?? CredentialStore(),
      _newClient = clientFactory ?? ((url) => ApiClient(baseUrl: url));

  final CredentialStore _store;

  /// 造 client 的方式。测试要能塞假 http.Client，否则 restore/login
  /// 这些分支只能靠打真后端验证——那些恰好是最容易出错的分支
  /// （token 过期该不该踢人、网络错误该不该踢人）。
  final ApiClient Function(String baseUrl) _newClient;

  AuthStage stage = AuthStage.booting;
  String baseUrl = '';
  String? token;
  User? user;
  Perms perms = Perms.empty;

  /// 上次成功登录用的用户名，登录页预填，省得每次敲。
  String? lastUsername;

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

    if (!creds.hasToken) {
      stage = AuthStage.needLogin;
      notifyListeners();
      return;
    }

    _client!.token = creds.token;
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
        stage = AuthStage.needLogin;
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
    try {
      await probe.authStatus();
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
    stage = AuthStage.needLogin;
    notifyListeners();
  }

  Future<void> login({required String username, required String password}) async {
    final c = _requireClient();
    final r = await c.login(username: username, password: password);
    await _finishLogin(c, r.token, username);
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
    stage = AuthStage.ready;
    notifyListeners();
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
