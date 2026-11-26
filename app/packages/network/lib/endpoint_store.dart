/// 换址结果的持久化。network 模块不碰存储细节（_secure_storage 是
/// 平台插件，不该拖进纯 Dart 包），login 用 CredentialStore 实现，
/// 测试用内存实现。没传 = 换址只在本会话生效。
abstract class EndpointStore {
  Future<void> saveBaseUrl(String url);
  Future<String?> readBaseUrl();
  Future<void> saveInstanceId(String id);
  Future<String?> readInstanceId();
}
