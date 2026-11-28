import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:qqbot_app/ui/scroll_rule.dart';

/// 群消息列表「自动贴底」的几何不变量。
///
/// 列表是 reverse: true：offset 0 = 底部（最新消息），maxScrollExtent = 顶部
/// （最老消息）。之前的 bug 把 maxScrollExtent 当底部去 jumpTo，每来一条新
/// 消息都会被拽到最顶上。这里直接钉住生产代码用的那条规则
/// （scroll_rule.dart 的 shouldFollowNewest），不依赖整个页面。
void main() {
  test('跟随规则：离最新那条 220 以内才算「本来在底部」', () {
    expect(shouldFollowNewest(0), isTrue);
    expect(shouldFollowNewest(100), isTrue);
    expect(shouldFollowNewest(followNewestThreshold), isTrue);
    // 往上翻了一屏多：不能再拽回去，否则用户正在看的卡片会被甩走
    expect(shouldFollowNewest(followNewestThreshold + 1), isFalse);
    expect(shouldFollowNewest(4000), isFalse);
  });

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

    // 模拟用户往上翻到很远：规则判定为「别再跟」
    controller.jumpTo(controller.position.maxScrollExtent / 2);
    await tester.pumpAndSettle();
    expect(shouldFollowNewest(controller.position.pixels), isFalse);

    // 回到贴底附近：规则判定为「跟着走」，目标是 0 而不是 maxScrollExtent
    controller.jumpTo(100);
    await tester.pumpAndSettle();
    if (shouldFollowNewest(controller.position.pixels)) {
      controller.jumpTo(0);
    }
    await tester.pumpAndSettle();
    expect(controller.position.pixels, 0);
    controller.dispose();
  });
}
