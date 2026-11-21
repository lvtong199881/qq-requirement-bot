import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:qqbot_app/ui/widgets/mentions.dart';

/// @ 名字的高亮：输入框和气泡共用同一套切分规则，
/// 所以这里钉住「切到哪停」和「停在哪一段」两件事。
void main() {
  const base = TextStyle(color: Color(0xFF111111));
  const hi = TextStyle(color: Color(0xFF2563EB));

  test('@ 到空格或标点为止', () {
    final spans = mentionSpans('@需求bot 帮我看看，@阿宝 也在', base, hi);
    final highlighted = spans
        .where((s) => s.style?.color == hi.color)
        .map((s) => s.text)
        .toList();
    expect(highlighted, ['@需求bot', '@阿宝']);
    // 整句还拼得回来，不能因为着色吃字
    expect(spans.map((s) => s.text).join(), '@需求bot 帮我看看，@阿宝 也在');
  });

  test('没有 @ 时只有一段，纯文本不受影响', () {
    final spans = mentionSpans('今天吃什么', base, hi);
    expect(spans, hasLength(1));
    expect(spans.single.style?.color, base.color);
  });

  testWidgets('输入框里已经打出的 @名字 用主题蓝', (tester) async {
    late BuildContext ctx;
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (c) {
            ctx = c;
            return const SizedBox.shrink();
          },
        ),
      ),
    );

    final controller = MentionEditingController(text: '@需求bot 在吗');
    final span = controller.buildTextSpan(
      context: ctx,
      style: base,
      withComposing: false,
    );
    final primary = Theme.of(ctx).colorScheme.primary;
    final colored = <String>[];
    span.visitChildren((s) {
      if (s is TextSpan && s.text != null && s.style?.color == primary) {
        colored.add(s.text!);
      }
      return true;
    });
    expect(colored, ['@需求bot']);
  });

  testWidgets('拼字过程中（有 composing）不加色，交给默认实现', (tester) async {
    late BuildContext ctx;
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (c) {
            ctx = c;
            return const SizedBox.shrink();
          },
        ),
      ),
    );

    final controller = MentionEditingController(text: '@xuqiu');
    controller.value = controller.value.copyWith(
      composing: const TextRange(start: 1, end: 6),
    );
    final span = controller.buildTextSpan(
      context: ctx,
      style: base,
      withComposing: true,
    );
    final primary = Theme.of(ctx).colorScheme.primary;
    final colored = <String>[];
    span.visitChildren((s) {
      if (s is TextSpan && s.style?.color == primary) colored.add(s.text ?? '');
      return true;
    });
    expect(colored, isEmpty);
  });
}
