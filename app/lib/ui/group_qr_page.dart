import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:gal/gal.dart';
import 'package:qr_flutter/qr_flutter.dart';
import 'package:share_plus/share_plus.dart';

import 'theme.dart';
import 'widgets/avatar.dart';
import 'widgets/toast.dart';

/// 群二维码：二维码里只放群号，扫出来就是群号，再走「加入群」那条路。
///
/// 为什么不把加入链接塞进二维码：链接得带域名，换隧道地址就等于所有旧码失效；
/// 群号是稳定的，扫出来不管在哪台机器上都能用。
class GroupQrPage extends StatelessWidget {
  const GroupQrPage({super.key, required this.threadId, required this.groupName});

  final String threadId;
  final String groupName;

  /// 二维码转 PNG：保存到相册要用字节，不能把屏幕截图丢进去
  /// （快照受字体缩放、主题影响，别人扫出来一样，但看起来脏）。
  Future<Uint8List> _qrPng({int size = 640}) => renderGroupQrBytes(threadId, size: size);

  Future<void> _copy(BuildContext context) async {
    await Clipboard.setData(ClipboardData(text: threadId));
    if (context.mounted) showToast(context, '群号已复制');
  }

  Future<void> _save(BuildContext context) async {
    try {
      final bytes = await _qrPng();
      await Gal.putImageBytes(bytes, album: 'qqbot');
      if (context.mounted) showToast(context, '已保存到相册');
    } catch (err) {
      if (context.mounted) showToast(context, '没保存成功：$err', error: true);
    }
  }

  Future<void> _share(BuildContext context) async {
    try {
      await SharePlus.instance.share(
        ShareParams(text: '加入群「$groupName」，群号：$threadId（在 App 里点「加入群」输入这个号）'),
      );
    } catch (err) {
      if (context.mounted) showToast(context, '分享失败：$err', error: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;

    return Scaffold(
      appBar: AppBar(title: const Text('群二维码')),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(
          AppInset.page,
          AppSpace.lg,
          AppInset.page,
          AppSpace.xl,
        ),
        children: [
          Center(
            child: Container(
              padding: const EdgeInsets.all(AppSpace.lg),
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(AppRadius.large),
              ),
              // 二维码本身要白底黑码，深色主题下也保持这个对比
              child: QrImageView(
                data: threadId,
                version: QrVersions.auto,
                size: 220,
                backgroundColor: Colors.white,
                eyeStyle: const QrEyeStyle(eyeShape: QrEyeShape.square, color: Color(0xFF000000)),
                dataModuleStyle: const QrDataModuleStyle(
                  dataModuleShape: QrDataModuleShape.square,
                  color: Color(0xFF000000),
                ),
              ),
            ),
          ),
          const SizedBox(height: AppSpace.md),
          Center(
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                InitialAvatar(name: groupName, size: 28),
                const SizedBox(width: AppSpace.xs),
                Flexible(child: Text(groupName, style: AppText.titleS)),
              ],
            ),
          ),
          const SizedBox(height: AppSpace.xs),
          Center(
            child: Text(
              '扫一扫就能加群',
              style: AppText.bodyS.copyWith(color: scheme.onSurfaceVariant),
            ),
          ),
          const SizedBox(height: AppSpace.xl),
          Container(
            padding: const EdgeInsets.symmetric(
              horizontal: AppSpace.md,
              vertical: AppSpace.sm,
            ),
            decoration: BoxDecoration(
              color: scheme.surfaceContainerLow,
              borderRadius: BorderRadius.circular(AppRadius.medium),
            ),
            child: Row(
              children: [
                Text('群号', style: AppText.bodyS.copyWith(color: scheme.onSurfaceVariant)),
                const SizedBox(width: AppSpace.md),
                Expanded(
                  child: SelectableText(
                    threadId,
                    style: AppText.body.copyWith(fontWeight: FontWeight.w600),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: AppSpace.lg),
          FilledButton.icon(
            onPressed: () => _copy(context),
            icon: const Icon(Icons.copy_all_outlined, size: 20),
            label: const Text('复制群号'),
          ),
          const SizedBox(height: AppSpace.sm),
          OutlinedButton.icon(
            onPressed: () => _save(context),
            icon: const Icon(Icons.download_outlined, size: 20),
            label: const Text('保存到相册'),
          ),
          const SizedBox(height: AppSpace.sm),
          OutlinedButton.icon(
            onPressed: () => _share(context),
            icon: const Icon(Icons.ios_share_outlined, size: 20),
            label: const Text('分享'),
          ),
        ],
      ),
    );
  }
}

/// 给测试用：不经过相册/分享，只验证二维码真能画出来。
///
/// 手工铺白底而不是用 QrPainter 的 emptyColor：那个参数已弃用，
/// 而且透明底的 PNG 某些相册/分享面板会渲染成一团黑。
Future<Uint8List> renderGroupQrBytes(String threadId, {int size = 320}) async {
  final painter = QrPainter(
    data: threadId,
    version: QrVersions.auto,
    gapless: true,
    eyeStyle: const QrEyeStyle(eyeShape: QrEyeShape.square, color: Color(0xFF000000)),
    dataModuleStyle: const QrDataModuleStyle(
      dataModuleShape: QrDataModuleShape.square,
      color: Color(0xFF000000),
    ),
  );
  final side = size.toDouble();
  // 二维码规范要求四周留 4 个模块的静区，否则不少扫码器贴边认不出来；
  // 这里按边长的 8% 留白，扫起来和屏幕上那张一样好认。
  final pad = side * 0.08;
  final code = side - pad * 2;
  final recorder = ui.PictureRecorder();
  final canvas = Canvas(recorder);
  canvas.drawRect(
    Rect.fromLTWH(0, 0, side, side),
    Paint()..color = const Color(0xFFFFFFFF),
  );
  canvas.translate(pad, pad);
  painter.paint(canvas, Size(code, code));
  final image = await recorder.endRecording().toImage(size, size);
  final data = await image.toByteData(format: ui.ImageByteFormat.png);
  image.dispose();
  return data!.buffer.asUint8List();
}
