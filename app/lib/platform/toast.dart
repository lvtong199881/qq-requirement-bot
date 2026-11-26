import 'package:flutter/services.dart';

/// 原生 toast 的样式类型。
///
/// 纯文本就不带 type；info/warning/error 对应原生端三套图标。
enum ToastType { info, warning, error }

/// 原生 toast：Android 走系统 Toast，iOS 走自绘浮层，样式统一「上图标下文案」。
///
/// 不依赖 context，也不用等它消失——原生层自己管生命周期；
/// loading 是常驻的，必须用 hideLoading 收掉。
///
/// 双端都在宿主 App 里注册了 'qqbot/toast' 通道；哪天缺了宿主实现
/// （比如单测、或页面跑在不带原生的环境），静默降级不崩。
class NativeToast {
  static const MethodChannel _channel = MethodChannel('qqbot/toast');

  static Future<void> _invoke(String method, Map<String, dynamic> args) async {
    try {
      await _channel.invokeMethod(method, args);
    } on MissingPluginException {
      // 宿主没实现通道（测试环境/未注册平台）就不弹，别让提示炸掉业务
    }
  }

  /// 弹一条会自动消失的 toast。[type] 为 null 时是纯文本样式。
  static Future<void> show(String text, {ToastType? type}) =>
      _invoke('show', {'text': text, 'type': type?.name});

  /// 常驻 loading，直到 [hideLoading]。
  static Future<void> showLoading(String text) =>
      _invoke('showLoading', {'text': text});

  /// 收掉 [showLoading] 弹出的 loading。
  static Future<void> hideLoading() => _invoke('hideLoading', {});
}
