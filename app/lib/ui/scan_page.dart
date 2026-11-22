import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import 'widgets/toast.dart';

/// 扫码：优先用相机，扫不动时可以改成从相册挑一张图。
///
/// 为什么不自己接相机：手写预览 + 对焦 + 旋转在 Android/iOS 上差异太大，
/// 引入 mobile_scanner 换来的是「扫一下就能连」而不是一堆兼容性 bug。
class ScanPage extends StatefulWidget {
  const ScanPage({
    super.key,
    this.hint = '对准服务器启动日志里的二维码',
    this.fallbackHint = '扫不到就把日志里那行地址手填进去',
  });

  /// 提示语跟着用途走：扫服务器地址和扫群二维码，想让人对准的东西不一样。
  final String hint;

  /// 扫不动时的退路也不一样：一个是手填地址，一个是手填群号。
  final String fallbackHint;

  @override
  State<ScanPage> createState() => _ScanPageState();
}

class _ScanPageState extends State<ScanPage> {
  // noDuplicates：同一个二维码只回调一次，否则 pop 之后还会被后续帧重复触发。
  final MobileScannerController _controller = MobileScannerController(
    formats: const [BarcodeFormat.qrCode],
    detectionSpeed: DetectionSpeed.noDuplicates,
  );

  final ImagePicker _picker = ImagePicker();

  bool _handled = false;
  bool _torch = false;
  bool _picking = false;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _onDetect(BarcodeCapture capture) {
    if (_handled) return;
    for (final barcode in capture.barcodes) {
      final value = barcode.rawValue?.trim() ?? '';
      if (value.isEmpty) continue;
      _handled = true;
      Navigator.of(context).pop(value);
      return;
    }
  }

  Future<void> _toggleTorch() async {
    try {
      await _controller.toggleTorch();
      if (mounted) setState(() => _torch = !_torch);
    } catch (_) {
      // 没有闪光灯的设备直接忽略，不值得弹错误
    }
  }

  /// 从相册挑一张图来认码。
  ///
  /// 相册里的图有两类特别常见：别人截图发过来的群二维码、
  /// 以及相机扫不出来时先拍下来的照片。给这条退路，
  /// 用户就不用「换个手机扫」或者「让对面重发一张」。
  Future<void> _pickFromGallery() async {
    if (_handled || _picking) return;
    setState(() => _picking = true);
    try {
      final file = await _picker.pickImage(source: ImageSource.gallery);
      if (file == null || !mounted) return; // 用户在相册里点了取消
      final capture = await _controller.analyzeImage(file.path);
      final found = _firstValue(capture);
      if (!mounted) return;
      if (found == null) {
        showToast(context, '这张图里没找到二维码', error: true);
        return;
      }
      _handled = true;
      Navigator.of(context).pop(found);
    } catch (err) {
      if (mounted) showToast(context, '这张图没认出来：$err', error: true);
    } finally {
      if (mounted) setState(() => _picking = false);
    }
  }

  String? _firstValue(BarcodeCapture? capture) {
    for (final barcode in capture?.barcodes ?? const <Barcode>[]) {
      final value = barcode.rawValue?.trim() ?? '';
      if (value.isNotEmpty) return value;
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        title: const Text('扫码'),
        backgroundColor: Colors.black,
        foregroundColor: Colors.white,
        actions: [
          IconButton(
            tooltip: '手电筒',
            icon: Icon(_torch ? Icons.flash_on : Icons.flash_off),
            onPressed: _toggleTorch,
          ),
        ],
      ),
      body: Stack(
        fit: StackFit.expand,
        children: [
          MobileScanner(controller: _controller, onDetect: _onDetect),
          IgnorePointer(
            // 取景框边长跟着屏幕走：小屏写死 240 会顶到边，
            // 大屏又小得像粒纽扣，取 min(宽 0.7, 280) 两头都能用。
            child: LayoutBuilder(
              builder: (context, constraints) {
                final short = constraints.biggest.shortestSide;
                final side = (short * 0.7).clamp(200.0, 280.0);
                return Center(
                  child: Container(
                    width: side,
                    height: side,
                    decoration: BoxDecoration(
                      border: Border.all(color: Colors.white70, width: 2),
                      borderRadius: BorderRadius.circular(16),
                    ),
                  ),
                );
              },
            ),
          ),
          Positioned(
            left: 24,
            right: 24,
            bottom: 48,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  widget.hint,
                  textAlign: TextAlign.center,
                  style: const TextStyle(
                    color: Colors.white,
                    fontSize: 15,
                    height: 1.4,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 8),
                Text(
                  widget.fallbackHint,
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    color: Colors.white.withValues(alpha: 0.7),
                    fontSize: 13,
                    height: 1.4,
                  ),
                ),
                const SizedBox(height: 16),
                TextButton.icon(
                  onPressed: _picking ? null : _pickFromGallery,
                  icon: const Icon(Icons.photo_library_outlined, size: 20),
                  label: const Text('从相册选图'),
                  style: TextButton.styleFrom(foregroundColor: Colors.white),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
