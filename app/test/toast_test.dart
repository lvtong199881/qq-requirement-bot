import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:qqbot_app/platform/toast.dart';

/// 原生 toast 是薄封装：弹窗本身在原生端渲染，Dart 侧只要钉住
/// 「方法名和参数按约定发出去」「宿主缺实现时不炸」这两件事。
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  final calls = <MethodCall>[];

  setUp(() {
    calls.clear();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(const MethodChannel('qqbot/toast'), (call) async {
      calls.add(call);
      return null;
    });
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(const MethodChannel('qqbot/toast'), null);
  });

  test('纯文本 toast 不带 type', () async {
    await NativeToast.show('已复制群号');
    expect(calls, hasLength(1));
    expect(calls.single.method, 'show');
    expect(calls.single.arguments, {'text': '已复制群号', 'type': null});
  });

  test('错误 toast 带上 error 类型，原生端据此选图标', () async {
    await NativeToast.show('没保存成功', type: ToastType.error);
    expect(calls.single.arguments, {'text': '没保存成功', 'type': 'error'});
  });

  test('info / warning 类型原样透传', () async {
    await NativeToast.show('提示', type: ToastType.info);
    await NativeToast.show('警告', type: ToastType.warning);
    expect(calls[0].arguments['type'], 'info');
    expect(calls[1].arguments['type'], 'warning');
  });

  test('loading 是独立方法，hide 负责收掉', () async {
    await NativeToast.showLoading('提交中');
    await NativeToast.hideLoading();
    expect(calls[0].method, 'showLoading');
    expect(calls[0].arguments, {'text': '提交中'});
    expect(calls[1].method, 'hideLoading');
  });

  test('宿主没注册通道时静默不崩（测试环境/未接入平台）', () async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(const MethodChannel('qqbot/toast'), null);
    // 不带 handler 时 invokeMethod 抛 MissingPluginException，show 要吞掉它
    await NativeToast.show('不该抛异常');
    await NativeToast.showLoading('也不该抛');
    await NativeToast.hideLoading();
  });
}
