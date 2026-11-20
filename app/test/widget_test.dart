import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:qqbot_app/main.dart';

/// 启动冒烟：能构建出来、第一屏不崩。
///
/// 不在这里测登录流程——那要打真实网络，属于集成测试的事。
/// widget 测试的价值是「改布局时立刻发现结构性错误」，保持轻。
void main() {
  testWidgets('App 能启动并显示加载态', (tester) async {
    await tester.pumpWidget(const QqbotApp());
    // 第一帧是 booting（在读本地凭据），应该有转圈
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
  });
}
