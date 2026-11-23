import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// 本地要记的三样东西：服务器地址、token、上次登录的用户名。
///
/// 用 secure storage 而不是 SharedPreferences：token 等价于密码，
/// 7 天有效，明文躺在 plist/prefs 里等于把门开着。iOS 走 Keychain、
/// Android 走 EncryptedSharedPreferences，都是系统级加密。
/// 用户名和服务器地址不敏感，但一起存省一个依赖。
class Creds {
  const Creds({required this.baseUrl, this.token, this.username});

  final String baseUrl;
  final String? token;
  final String? username;

  bool get hasToken => token != null && token!.isNotEmpty;
}

class CredentialStore {
  CredentialStore({FlutterSecureStorage? storage})
    : _storage = storage ?? const FlutterSecureStorage();

  final FlutterSecureStorage _storage;

  static const _kBaseUrl = 'server_base_url';
  static const _kToken = 'auth_token';
  static const _kUsername = 'auth_username';
  static const _kInstanceId = 'server_instance_id';

  Future<Creds?> load() async {
    try {
      final baseUrl = await _storage.read(key: _kBaseUrl);
      if (baseUrl == null || baseUrl.isEmpty) return null;
      return Creds(
        baseUrl: baseUrl,
        token: await _storage.read(key: _kToken),
        username: await _storage.read(key: _kUsername),
      );
    } catch (_) {
      // 读保险箱失败（钥匙串被锁、模拟器迁移…）就当没配过，
      // 让用户重新填一遍。总比启动即崩强。
      return null;
    }
  }

  Future<void> saveBaseUrl(String baseUrl) =>
      _storage.write(key: _kBaseUrl, value: baseUrl);

  /// 后端实例指纹：换址时校验「新地址后面还是同一台后端」。
  /// 首次连接时从 /api/auth/status 学到，永久保留。
  Future<String?> readInstanceId() async {
    try {
      return await _storage.read(key: _kInstanceId);
    } catch (_) {
      return null;
    }
  }

  Future<void> saveInstanceId(String id) =>
      _storage.write(key: _kInstanceId, value: id);

  Future<void> saveSession({required String token, required String username}) async {
    await _storage.write(key: _kToken, value: token);
    await _storage.write(key: _kUsername, value: username);
  }

  /// 只清 token，保留服务器地址和用户名——退出登录不该让人重填地址。
  Future<void> clearToken() async {
    await _storage.delete(key: _kToken);
  }
}
