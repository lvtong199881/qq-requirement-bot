/// 网络层。与业务无关：请求封装、模型、隧道换址（发现 + 验证 + 静默切换）
/// 和后台心跳都住在这里，上层只面对 [ServerEndpointManager]。
library;

export 'api_client.dart';
export 'api_exception.dart';
export 'endpoint_manager.dart';
export 'endpoint_resolver.dart';
export 'endpoint_store.dart';
export 'heartbeat.dart';
export 'models.dart';
