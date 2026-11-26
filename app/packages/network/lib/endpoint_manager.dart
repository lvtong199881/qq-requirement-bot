import 'api_client.dart';
import 'api_exception.dart';
import 'endpoint_resolver.dart';
import 'endpoint_store.dart';
import 'heartbeat.dart';

/// 服务器地址的「当前值」及其背后的 client，加上整条换址链路。
///
/// 换址（发现 → 验证 → 静默切换）、failover 重试、后台心跳都住在 network
/// 这一层——它们跟「登录」没关系：token 是什么、什么状态下才允许换址，
/// 才是上层（login）的事。分工：
/// - token：由 login 侧写进 client（[ApiClient.token]）；静默换址时
///   从旧 client 平移到新 client，login 不用管；
/// - 持久化：经 [EndpointStore] 抽象，login 用 CredentialStore 实现；
/// - 心跳门控：[beatGate] 由 login 注入（「已登录才拍」）——机制、
///   发现、验证、换址全在本模块，只有门控条件涉及会话状态。
class ServerEndpointManager {
  ServerEndpointManager({
    this.resolver,
    this.store,
    ApiClient Function(String baseUrl)? clientFactory,
  }) : _newClient = clientFactory ?? ((url) => ApiClient(baseUrl: url)) {
    _heartbeat = NetworkHeartbeat(
      onBeat: () async {
        try {
          await tryResolveAndSwap();
        } catch (_) {
          // 心跳失败不能影响界面：下一拍再试，换址本身已经有冷却保护。
        }
      },
    );
    _heartbeat.canBeat = () => beatGate?.call() ?? true;
  }

  /// 发现 + 验证器。null = 没配发现通道，自动换址与心跳全部关闭，
  /// 行为退回「连不上就提示」。可整体替换（测试缝）。
  EndpointResolver? resolver;

  final EndpointStore? store;
  final ApiClient Function(String baseUrl) _newClient;

  late final NetworkHeartbeat _heartbeat;

  /// 心跳门控：返回 false 时这一拍直接跳过（比如未登录——没有 token，
  /// 换址也验不了身份）。
  bool Function()? beatGate;

  /// 静默换址成功后的回调（上层用来刷新界面）。
  void Function()? onSwapped;

  ApiClient? _client;

  /// 当前生效的服务器地址（attach/换址时更新；未连接时为空串）。
  String baseUrl = '';

  /// 本机学到的这台后端的指纹（/api/auth/status 首次连接时记下来）。
  /// 换址时用它确认新地址后面还是同一台后端。
  String? instanceId;

  /// 已连接时非空。未连接时调用方必须先判 [hasClient]。
  ApiClient get client {
    final c = _client;
    if (c == null) throw StateError('还没登录，不该在这时候请求 /api');
    return c;
  }

  bool get hasClient => _client != null;

  bool get heartbeatRunning => _heartbeat.running;

  /// 启动时恢复现场：建 client、把 token 挂上、把学过的实例指纹读回来。
  Future<void> attach(String baseUrl, {String? token}) async {
    this.baseUrl = baseUrl;
    _client = _newClient(baseUrl)..token = token;
    instanceId = await store?.readInstanceId();
  }

  /// 「换服务器」（用户手动改地址）：地址持久化 + 重建不带 token 的 client。
  /// 清 token 是「换了后端旧凭据必失效」的业务决定，由 login 侧做。
  Future<void> resetServer(String url) async {
    await store?.saveBaseUrl(url);
    baseUrl = url;
    _client = _newClient(url)..token = null;
  }

  /// 探活用的临时 client（改地址前先打一次 /api/auth/status 试试通不通），
  /// 用完由调用方 close。不改变当前连接。
  ApiClient createClient(String url) => _newClient(url);

  /// 测试缝：直接塞一个现成 client。正常代码不要用——attach 自己会建。
  void attachClientForTest(ApiClient c) => _client = c;

  /// 测试缝：替换换址器（构造时也行，但 attach 之后换的场合用这个）。
  void nextResolverForTest(EndpointResolver r) => resolver = r;

  /// 静默换址：**不清 token、不断会话**。
  ///
  /// 隧道换的只是入口，后端用户表没变，token 依然有效——所以只换
  /// client 和地址，上层界面连闪都不闪一下。换址前 caller
  /// （[tryResolveAndSwap]）已经验证过 instanceId + token。
  Future<bool> swapServerSilently(String url) async {
    final normalized = normalizeBaseUrl(url);
    if (normalized.isEmpty) return false;
    final c = _newClient(normalized)..token = _client?.token;
    final old = _client;
    _client = c;
    baseUrl = normalized;
    await store?.saveBaseUrl(normalized);
    old?.close();
    onSwapped?.call();
    return true;
  }

  /// 走一遍「发现 → 验证 → 静默换址」。成功返回 true。
  /// 没配发现通道、验证不过、全部候选都挂，都返回 false（保持现状）。
  Future<bool> tryResolveAndSwap() async {
    final r = resolver;
    if (r == null) return false;
    final url = await r.resolve(knownInstanceId: instanceId ?? '', token: _client?.token);
    if (url == null) return false;
    return swapServerSilently(url);
  }

  /// 顺手记下这台后端的指纹（失败不影响调用方的主流程）。
  Future<void> learnInstanceId() async {
    try {
      final st = await client.authStatus();
      if (st.instanceId == null || st.instanceId!.isEmpty) return;
      instanceId = st.instanceId;
      await store?.saveInstanceId(st.instanceId!);
    } on ApiException {
      // 学不到就算了：下次连接再学。换址校验没有指纹时退化为只验 token。
    }
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
      final swapped = await tryResolveAndSwap();
      if (!swapped) rethrow;
      return fn(client);
    }
  }

  /// 后台心跳：只在配了发现通道时才跑（没通道换址关着，拍了也没用）。
  void startHeartbeat() {
    if (resolver == null) return;
    _heartbeat.start();
  }

  void stopHeartbeat() => _heartbeat.stop();

  /// 测试用：手动触发一拍（不用等 60s 定时器）。
  Future<void> beatForTest() => _heartbeat.beat();

  void dispose() {
    _heartbeat.stop();
    _client?.close();
  }
}
