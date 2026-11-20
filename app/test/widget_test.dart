import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:qqbot_app/main.dart';

/// 启动冒烟：能构建出来、第一屏不崩。
///
/// 不在这里测登录流程——那要打真实网络，属于集成测试的事。
/// widget 测试的价值是「改布局时立刻发现结构性错误」，保持轻。
void main() {
  testWidgets('App 能启动，转圈要等一秒才出现', (tester) async {
    await tester.pumpWidget(const QqbotApp());
    // 恢复会话通常几十毫秒，立刻闪一下转圈反而像卡了一下：
    // 第一帧应该是空白，不是 spinner
    expect(find.byType(CircularProgressIndicator), findsNothing);

    await tester.pump(const Duration(milliseconds: 1100));
    // 过了一秒还没就位（或已经就位到别的页），至少不该崩
    expect(tester.takeException(), isNull);
  });
}
