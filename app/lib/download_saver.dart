import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

/// 下载产物保存到公共目录（文件管理器/相册能看到）的通道。
///
/// 权限模型在原生侧（DownloadSaver.kt）：API 29+ 走 MediaStore 无需权限；
/// API <29 靠 WRITE_EXTERNAL_STORAGE（maxSdkVersion 28）。Dart 侧只管调。
class DownloadSaver {
  static const _channel = MethodChannel('qqbot/download_saver');

  // 测试要给通道挂 mock，通道实例得可访问；不开放会逼测试用字符串再造
  // 一个同名 MethodChannel，反而更容易和实现漂移。
  @visibleForTesting
  static MethodChannel get channelForTest => _channel;

  /// 保存字节。返回对用户可读的保存位置（如「Download/qqbot/PRD.md」）。
  ///
  /// 通道没注册（非 Android 平台、老引擎）时退回私有临时目录——
  /// 桌面端调试时下载仍可用，只是位置不可见。
  static Future<String> save(String name, List<int> bytes) async {
    try {
      final r = await _channel
          .invokeMethod<String>('save', {'name': name, 'bytes': Uint8List.fromList(bytes)})
          .timeout(const Duration(seconds: 20));
      return r ?? '';
    } on MissingPluginException {
      return _fallback(name, bytes);
    } on PlatformException {
      rethrow;
    }
  }

  static Future<String> _fallback(String name, List<int> bytes) async {
    final file = File('${Directory.systemTemp.path}/$name');
    await file.writeAsBytes(bytes, flush: true);
    return file.path;
  }
}
