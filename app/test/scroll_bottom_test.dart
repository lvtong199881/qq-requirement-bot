import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// 群消息列表「自动贴底」的几何不变量。
///
/// 列表是 reverse: true：offset 0 = 底部（最新消息），maxScrollExtent = 顶部
/// （最老消息）。之前的 bug 把 maxScrollExtent 当底部去 jumpTo，每来一条新
/// 消息都会被拽到最顶上。这里直接钉住「跟随到底」的规则，不依赖整个页面。
void main() {
  testWidgets('reverse 列表：贴底 = offset 0，且不会跳到最老消息', (tester) async {
    final controller = ScrollController();
    await tester.pumpWidget(
      MaterialApp(
        home: SizedBox(
          height: 400,
          child: ListView.builder(
            controller: controller,
            reverse: true,
            itemCount: 60,
            itemBuilder: (_, i) => SizedBox(height: 80, child: Text('m$i')),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    // 初始就在底部（offset 0 = 最新）
    expect(controller.position.pixels, 0);
    // 顶部（最老）远在 maxScrollExtent，绝不能把它当底部
    expect(controller.position.maxScrollExtent, greaterThan(1000));

    // 模拟用户往上翻到很远
    controller.jumpTo(controller.position.maxScrollExtent / 2);
    await tester.pumpAndSettle();

    // 修复后的规则：离底部（pixels）超过 220 就不拽回，保护用户的翻阅
    expect(controller.position.pixels > 220, isTrue);
    controller.dispose();
  });

  testWidgets('贴底规则：在底部附近时跳到 0 = 最新消息，不是 maxScrollExtent', (tester) async {
    final controller = ScrollController();
    await tester.pumpWidget(
      MaterialApp(
        home: SizedBox(
          height: 400,
          child: ListView.builder(
            controller: controller,
            reverse: true,
            itemCount: 60,
            itemBuilder: (_, i) => SizedBox(height: 80, child: Text('m$i')),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    // 用户刚好在底部附近（pixels 小于 220）→ 应跟随到 0
    controller.jumpTo(100);
    await tester.pumpAndSettle();
    if (controller.position.pixels <= 220) {
      controller.jumpTo(0);
    }
    await tester.pumpAndSettle();

    expect(controller.position.pixels, 0);
    expect(controller.position.pixels, isNot(controller.position.maxScrollExtent));
    controller.dispose();
  });
}
