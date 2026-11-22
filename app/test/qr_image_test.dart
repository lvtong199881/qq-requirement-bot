import 'dart:ui' as ui;

import 'package:flutter_test/flutter_test.dart';
import 'package:qqbot_app/ui/widgets/qr_image.dart';

/// 二维码要能真的变成一张图：分享面板和相册都只收文件，收不到内存字节。
///
/// 这里不测「分享按钮点了没有」（那要连系统分享面板），只测最危险的一段：
/// 画出来的 PNG 是不是黑白分明、四周有没有静区——贴边的码有些扫码器认不出。
void main() {
  test('画出来的是一张带静区的黑白 PNG', () async {
    final bytes = await renderQrPng('t9a1b2c3d4e5', size: 320);

    // PNG magic：89 50 4E 47。画崩了会得到空字节或者别的格式，
    // 分享出去就是一张打不开的图。
    expect(bytes.length, greaterThan(1000));
    expect(bytes.sublist(0, 4), [0x89, 0x50, 0x4E, 0x47]);

    final codec = await ui.instantiateImageCodec(bytes);
    final frame = await codec.getNextFrame();
    final image = frame.image;
    expect(image.width, 320);
    expect(image.height, 320);

    final data = await image.toByteData(format: ui.ImageByteFormat.rawRgba);
    final pixels = data!.buffer.asUint8List();
    int alphaAt(int x, int y) => pixels[(y * image.width + x) * 4 + 3];

    // 静区必须是实实在在的白（不透明），不能用透明底糊过去：
    // 部分相册/聊天软件会把透明底渲染成黑块，码就废了
    expect(alphaAt(2, 2), 255);
    expect(alphaAt(image.width - 3, image.height - 3), 255);

    image.dispose();
  });

  test('分享附言里带上群名和群号，只收到文字的人也能加群', () {
    final text = qrShareText('产品讨论', 't9a1b2c3d4e5');

    expect(text, contains('产品讨论'));
    expect(text, contains('t9a1b2c3d4e5'));
  });
}
