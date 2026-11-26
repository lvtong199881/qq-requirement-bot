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
