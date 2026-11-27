import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:qqbot_app/download_saver.dart';

/// 下载保存通道的 Dart 侧行为：
/// 1) 原生通了就把原生回的位置透传给调用方；
/// 2) 通道没注册（非 Android 平台）退回私有临时目录，下载不至完全不可用。
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(DownloadSaver.channelForTest, (call) async {
    switch (call.method) {
      case 'save':
        return 'Download/qqbot/${call.arguments['name']}';
      default:
        throw MissingPluginException();
    }
  });

  test('原生保存成功时透传位置', () async {
    final where = await DownloadSaver.save('PRD.md', [1, 2, 3]);
    expect(where, 'Download/qqbot/PRD.md');
  });

  test('原生报错原样抛出，调用方显示失败', () async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(DownloadSaver.channelForTest, (call) async {
      throw PlatformException(code: 'save_failed', message: 'MediaStore 插入失败');
    });
    expect(
      DownloadSaver.save('x.md', [1]),
      throwsA(isA<PlatformException>()),
    );
  });

  test('通道没注册时退回私有临时目录（桌面端调试）', () async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(DownloadSaver.channelForTest, null);
    final where = await DownloadSaver.save('fallback.txt', [9]);
    expect(where, endsWith('fallback.txt'));
    // Windows 大小写不敏感路径 Temp/temp 都算系统临时目录
    expect(where.toLowerCase(), contains('temp'));
  });
}
