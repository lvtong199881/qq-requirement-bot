import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import '../api/client.dart';

/// 换址过程的调试日志（仅 debug 构建输出）。换址是「用户无感」的静默
/// 行为，出问题时没有界面反馈，没有日志就完全黑盒。
void _log(String msg) {
  if (kDebugMode) debugPrint('[resolver] $msg');
}

/// 隧道换址的「发现 + 验证」。
///
/// 免费版 trycloudflare 每次重启换域名。App 里写死的 baseUrl 一旦失效，
/// 光靠 App 自己永远猜不出新地址——必须有一条比隧道更稳的「发现通道」
/// （一个静态 JSON 文件，服务器换址时把它更新上去）。本类负责：
///
/// 1. 拉发现通道，拿候选 URL 列表（当前地址在前）；
/// 2. 逐个探测 `/healthz`；
/// 3. 对通了的服务器做双重校验：
///    - `instanceId` 与本地记录一致 → 防「发现文件被改指向别人的服务器」，
///      token 不能发去陌生后端；
///    - 现有 token 能过 `/api/auth/me` → 防「换址恰逢 token 过期」，
///      宁可让用户正常重登，也不给他一个看似在线的假界面。
///
/// 全挂就保持原地址并进入冷却期：服务器真宕机时不该疯狂打发现通道。
class EndpointResolver {
  EndpointResolver({
    required this.discoveryUrl,
    http.Client? httpClient,
    this.probeTimeout = const Duration(seconds: 5),
    this.cooldown = const Duration(seconds: 60),
    this.maxCandidates = 3,
  }) : _http = httpClient ?? http.Client();

  /// 发现通道地址（一个静态 JSON），比隧道本身稳。
  final String discoveryUrl;
  final http.Client _http;
  final Duration probeTimeout;
  final Duration cooldown;

  /// 候选最多试几个：发现文件里的旧地址也可能早被回收，别全试一遍拖时间。
  final int maxCandidates;

  /// 冷却截止时刻；冷却期内 resolve 直接失败，不再发任何请求。
  DateTime? _cooldownUntil;

  /// 是否在冷却中（暴露给测试和上层诊断用）。
  bool get cooling => _cooldownUntil != null && DateTime.now().isBefore(_cooldownUntil!);

  /// 发现通道文件的形状。
  ///
  /// instanceId 用于确认「这台就是我当时连的那台后端」；
  /// urls 首位是当前地址，后面是最近用过的旧地址（兜底：发现文件没来得及更新时，
  /// 旧地址反而还活着的情况确实存在——多隧道并行的那一小段时间）。
  ///
  /// 兼容两种载体：裸 JSON（GitHub raw / 本地 file://）和 Gitee contents
  /// API 的响应（{content: "<base64>", encoding: "base64", ...}）。
  /// 用 API 而不是 gitee raw 页面，是因为 raw 的真实文件在
  /// raw.giteeusercontent.com 域名下，国内手机网络经常整个被重置；
  /// gitee.com 主站 + API 路径实测可达。
  ({String instanceId, List<String> urls})? _parseDiscovery(String body) {
    final dynamic decoded;
    try {
      decoded = jsonDecode(body);
    } catch (_) {
      return null;
    }
    if (decoded is! Map) return null;
    // Gitee contents API 形态：真正的内容藏在 base64 的 content 字段里
    if (decoded['encoding'] == 'base64' && decoded['content'] is String) {
      try {
        final inner = jsonDecode(utf8.decode(base64Decode(decoded['content'] as String)));
        return _parsePlain(inner);
      } catch (_) {
        return null;
      }
    }
    return _parsePlain(decoded);
  }

  ({String instanceId, List<String> urls})? _parsePlain(dynamic decoded) {
    if (decoded is! Map) return null;
    final rawUrls = decoded['urls'];
    if (rawUrls is! List) return null;
    final urls = rawUrls
        .whereType<String>()
        // 先按原始串过滤：normalizeBaseUrl 会给不带协议的串补 http://，
        // 「ftp://weird」会被它改写成「http://ftp://weird」照样以 http 开头，
        // 过滤必须放在改写之前。
        .where((u) => u.startsWith('http://') || u.startsWith('https://'))
        .map(normalizeBaseUrl)
        .toSet()
        .toList();
    if (urls.isEmpty) return null;
    return (instanceId: (decoded['instanceId'] ?? '').toString(), urls: urls);
  }

  /// 拉发现通道并逐个验证候选，返回通过全部校验的地址。
  /// 返回 null 表示没找到可信的换址目标（调用方应保持原地址、进入冷却）。
  Future<String?> resolve({required String knownInstanceId, required String? token}) async {
    if (cooling) {
      _log('冷却中（至 $_cooldownUntil），跳过本次 resolve');
      return null;
    }
    final String body;
    try {
      final res = await _http
          .get(Uri.parse(discoveryUrl))
          .timeout(probeTimeout);
      if (res.statusCode != 200) throw ApiException('发现通道 ${res.statusCode}');
      body = utf8.decode(res.bodyBytes);
    } on Exception catch (e) {
      _log('拉发现通道失败：$e');
      _startCooldown();
      return null;
    }

    final found = _parseDiscovery(body);
    if (found == null) {
      _log('发现内容解析失败（长度 ${body.length}）');
      _startCooldown();
      return null;
    }
    _log('发现通道给出 ${found.urls.length} 个候选，本地指纹 $knownInstanceId');

    for (final url in found.urls.take(maxCandidates)) {
      if (knownInstanceId.isEmpty) {
        // 本地还没学过指纹（首次连接前就断链）→ 只验 token，不验指纹。
        // 这是唯一允许缺指纹的分支：没有指纹可比对时，「token 过验」已经
        // 是这套机制能给出的最强确认。
      } else if (found.instanceId != knownInstanceId) {
        _log('候选 $url 指纹不符（远端 ${found.instanceId}），跳过');
        continue;
      }
      if (!await _verify(url, token)) {
        _log('候选 $url 验证不过');
        continue;
      }
      _log('候选 $url 通过，换址');
      return url;
    }
    _log('全部候选失败，进冷却');
    _startCooldown();
    return null;
  }

  /// 单个候选的验证：healthz 探活 + 带 token 的 /api/auth/me。
  Future<bool> _verify(String url, String? token) async {
    // 探活不带 token：这一步只确认「隧道后面活着」，不把凭据发给
    // 还没验证过 instanceId 的地址。
    try {
      final res = await _http.get(Uri.parse('$url/healthz')).timeout(probeTimeout);
      _log('探活 $url/healthz → ${res.statusCode}');
      if (res.statusCode != 200) return false;
      final map = jsonDecode(utf8.decode(res.bodyBytes));
      if (map is! Map || map['ok'] != true) return false;
    } on Exception {
      return false;
    }
    if (token == null || token.isEmpty) {
      _log('候选 $url：无 token 可验，否决');
      return false;
    }
    try {
      final res = await _http
          .get(
            Uri.parse('$url/api/auth/me'),
            headers: {'authorization': 'Bearer $token'},
          )
          .timeout(probeTimeout);
      _log('带 token 验证 $url/api/auth/me → ${res.statusCode}');
      if (res.statusCode != 200) return false;
      final map = jsonDecode(utf8.decode(res.bodyBytes));
      return map is Map && map['ok'] == true;
    } on Exception {
      return false;
    }
  }

  void _startCooldown() {
    _cooldownUntil = DateTime.now().add(cooldown);
  }
}
