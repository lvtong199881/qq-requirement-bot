import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import 'package:qr_flutter/qr_flutter.dart';

/// 二维码渲染与「把二维码变成能分享的图片」都收在这里。
///
/// 分享和保存都要求一份真正的图片文件：分享面板拿不到字节流，
/// 系统相册也不收内存里的 [Uint8List]，所以离开这个文件前必须落地。

/// 手工铺白底而不是用 [QrPainter] 的 emptyColor：那个参数已弃用，
/// 而且透明底的 PNG 某些相册/分享面板会渲染成一团黑。
Future<Uint8List> renderQrPng(String data, {int size = 640}) async {
  final painter = QrPainter(
    data: data,
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
  final data2 = await image.toByteData(format: ui.ImageByteFormat.png);
  image.dispose();
  return data2!.buffer.asUint8List();
}

/// 分享二维码时一并带上的那句话。
///
/// 为什么还要带文字：有些接收端（比如只会转发文本的应用）会丢掉图片附件，
/// 这时候对方至少还能看到群名和群号，手动加群也加得进去。
String qrShareText(String groupName, String threadId) =>
    '加入群「$groupName」，扫这张码或在 App 里点「加入群」输入群号：$threadId';

/// 把二维码字节落到临时目录，返回文件。
///
/// 文件名带群号：分享面板和相册都会把文件名显示给用户，
/// 一串随机 UUID 谁也认不出是哪个群。
Future<File> writeQrTempFile(String threadId, Uint8List bytes) async {
  final dir = await getTemporaryDirectory();
  final safe = threadId.replaceAll(RegExp(r'[^A-Za-z0-9_-]'), '_');
  final file = File('${dir.path}/群二维码-$safe.png');
  await file.writeAsBytes(bytes, flush: true);
  return file;
}
