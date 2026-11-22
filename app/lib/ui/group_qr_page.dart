import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:gal/gal.dart';
import 'package:qr_flutter/qr_flutter.dart';
import 'package:share_plus/share_plus.dart';

import 'theme.dart';
import 'widgets/avatar.dart';
import 'widgets/qr_image.dart';
import 'widgets/toast.dart';

/// 群二维码：二维码里只放群号，扫出来就是群号，再走「加入群」那条路。
///
/// 为什么不把加入链接塞进二维码：链接得带域名，换隧道地址就等于所有旧码失效；
/// 群号是稳定的，扫出来不管在哪台机器上都能用。
class GroupQrPage extends StatelessWidget {
  const GroupQrPage({super.key, required this.threadId, required this.groupName});

  final String threadId;
  final String groupName;

  /// 二维码转 PNG：保存到相册和分享都要用字节，不能把屏幕截图丢进去
  /// （快照受字体缩放、主题影响，别人扫出来一样，但看起来脏）。
  Future<Uint8List> _qrPng({int size = 640}) => renderQrPng(threadId, size: size);

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

  /// 分享的是那张二维码图，不是群号文本。
  ///
  /// 收的人可能根本不在这个 App 里，一张能扫的图比一串「t9a1b2c3d4e5」直接；
  /// 群名和群号仍然作为附言带上，方便对方看图时也知道是哪个群。
  Future<void> _share(BuildContext context) async {
    try {
      final bytes = await _qrPng();
      final file = await writeQrTempFile(threadId, bytes);
      await SharePlus.instance.share(
        ShareParams(
          files: [XFile(file.path, mimeType: 'image/png')],
          // 有些接收端只认文本、忽略图片，附言让它在那种情况下也不至于是一张白图
          text: qrShareText(groupName, threadId),
        ),
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
Future<Uint8List> renderGroupQrBytes(String threadId, {int size = 320}) =>
    renderQrPng(threadId, size: size);
