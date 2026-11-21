import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:qqbot_app/ui/theme.dart';
import 'package:qqbot_app/ui/widgets/avatar.dart';

/// 群头像/成员头像都只有首字，所以「首字取对」「同一个名字永远同一个色」
/// 这两条就是全部行为，得钉住。
void main() {
  test('首字：取第一个字符，空名字给问号', () {
    expect(InitialAvatar.initialOf('产品讨论'), '产');
    expect(InitialAvatar.initialOf('  ai 助手 '), 'A');
    expect(InitialAvatar.initialOf(''), '?');
    expect(InitialAvatar.initialOf('   '), '?');
  });

  test('颜色：同一个名字稳定，不同名字尽量分开', () {
    final a = InitialAvatar.tintOf('产品讨论');
    expect(InitialAvatar.tintOf('产品讨论'), a);
    // 名字里多一个空格不该换色
    expect(InitialAvatar.tintOf(' 产品讨论 '), a);

    final tints = <Color>{
      for (final n in ['产品讨论', '首页改版', '登录体验', 'AI员工', '市场群', 'bug 修复'])
        InitialAvatar.tintOf(n),
    };
    expect(tints.length, greaterThan(1));
    expect(tints, everyElement(isIn(AppColors.candies)));
  });

  testWidgets('机器人头像右下角带小标记', (tester) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: Center(child: InitialAvatar(name: 'AI员工', size: 40, isBot: true)),
        ),
      ),
    );

    expect(find.text('A'), findsOneWidget);
    expect(find.byIcon(Icons.smart_toy_outlined), findsOneWidget);
  });
}
