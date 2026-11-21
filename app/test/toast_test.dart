import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:qqbot_app/ui/widgets/toast.dart';

/// toast 的契约很短但很硬：文字要浮在页面上、过几秒自己消失、不挡主操作。
void main() {
  testWidgets('弹出来、能看见、过一会儿自己消失', (tester) async {
    await tester.pumpWidget(
      const MaterialApp(home: Scaffold(body: Center(child: Text('底页')))),
    );

    final ctx = tester.element(find.text('底页'));
    showToast(ctx, '群号已复制');
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 250));

    expect(find.text('群号已复制'), findsOneWidget);

    // 淡出 + 移除
    await tester.pump(const Duration(seconds: 3));
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('群号已复制'), findsNothing);
  });

  testWidgets('出错时用错误色，不是主题的反色', (tester) async {
    await tester.pumpWidget(
      const MaterialApp(home: Scaffold(body: Center(child: Text('底页')))),
    );

    final ctx = tester.element(find.text('底页'));
    showToast(ctx, '没保存成功', error: true);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 250));

    final box = tester.widget<DecoratedBox>(
      find.ancestor(of: find.text('没保存成功'), matching: find.byType(DecoratedBox)).first,
    );
    final decoration = box.decoration as BoxDecoration;
    expect(decoration.color, Theme.of(ctx).colorScheme.errorContainer);

    await tester.pump(const Duration(seconds: 4));
  });
}
