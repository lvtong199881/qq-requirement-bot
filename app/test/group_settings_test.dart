import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:qqbot_app/ui/group_settings_page.dart';

import 'support.dart';

/// 群设置页三块：群信息（改名）、群成员（群主指定管理员）、群聊信息（群号/二维码）。
void main() {
  Map<String, dynamic> thread({String name = '产品讨论'}) => {
    'threadId': 't1',
    'groupName': name,
    'mode': 'chat',
    'pending': true,
    'memberCount': 3,
    'myRole': 'owner',
    'stages': [],
  };

  List<Map<String, dynamic>> members() => [
    {'userId': 'u1', 'nickname': '产品阿宝', 'role': 'owner', 'isBot': false},
    {'userId': 'u_bot', 'nickname': 'AI员工', 'role': 'admin', 'isBot': true},
    {'userId': 'u2', 'nickname': '小周', 'role': 'member', 'isBot': false},
  ];

  testWidgets('三块都在：群名、成员、群号与二维码入口', (tester) async {
    final auth = await readyAuth((req) async {
      if (req.url.path == '/api/threads/t1/members') {
        return ok({
          'ownerId': 'u1',
          'canManage': true,
          'canRename': true,
          'members': members(),
        });
      }
      if (req.url.path == '/api/threads/t1') return ok({'thread': thread()});
      return ok({});
    });

    await tester.pumpWidget(
      MaterialApp(home: GroupSettingsPage(auth: auth, threadId: 't1')),
    );
    await tester.pumpAndSettle();

    expect(find.text('群设置'), findsOneWidget);
    expect(find.text('产品讨论'), findsWidgets);
    expect(find.text('群成员'), findsOneWidget);
    expect(find.text('AI员工'), findsOneWidget);
    expect(find.text('小周'), findsOneWidget);
    // 机器人和群主的身份要看得出来，不能只靠颜色
    expect(find.text('管理员'), findsOneWidget);
    expect(find.text('群主'), findsOneWidget);
    expect(find.text('群号'), findsOneWidget);
    expect(find.text('t1'), findsWidgets);
    expect(find.text('二维码'), findsOneWidget);
  });

  testWidgets('改群名：走 PATCH，标题跟着变', (tester) async {
    String? patched;
    final auth = await readyAuth((req) async {
      if (req.method == 'PATCH' && req.url.path == '/api/threads/t1') {
        final body = jsonDecode(req.body) as Map<String, dynamic>;
        patched = body['name'] as String?;
        return ok({'thread': thread(name: body['name'] as String)});
      }
      if (req.url.path == '/api/threads/t1/members') {
        return ok({
          'ownerId': 'u1',
          'canManage': true,
          'canRename': true,
          'members': members(),
        });
      }
      if (req.url.path == '/api/threads/t1') return ok({'thread': thread()});
      return ok({});
    });

    await tester.pumpWidget(
      MaterialApp(home: GroupSettingsPage(auth: auth, threadId: 't1')),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('群聊名称'));
    await tester.pumpAndSettle();
    expect(find.text('改群名'), findsOneWidget);

    await tester.enterText(find.byType(TextField), '登录体验');
    await tester.tap(find.text('保存'));
    await tester.pumpAndSettle();

    expect(patched, '登录体验');
    expect(find.text('登录体验'), findsWidgets);
    expect(find.text('群名已改'), findsOneWidget);
  });

  testWidgets('群主把成员设成管理员', (tester) async {
    String? roleBody;
    final auth = await readyAuth((req) async {
      if (req.url.path == '/api/threads/t1/members/u2/role') {
        roleBody = req.body;
        return ok({
          'members': [
            {'userId': 'u1', 'nickname': '产品阿宝', 'role': 'owner', 'isBot': false},
            {'userId': 'u_bot', 'nickname': 'AI员工', 'role': 'admin', 'isBot': true},
            {'userId': 'u2', 'nickname': '小周', 'role': 'admin', 'isBot': false},
          ],
        });
      }
      if (req.url.path == '/api/threads/t1/members') {
        return ok({
          'ownerId': 'u1',
          'canManage': true,
          'canRename': true,
          'members': members(),
        });
      }
      if (req.url.path == '/api/threads/t1') return ok({'thread': thread()});
      return ok({});
    });

    await tester.pumpWidget(
      MaterialApp(home: GroupSettingsPage(auth: auth, threadId: 't1')),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('小周'));
    await tester.pumpAndSettle();
    expect(find.text('把 小周 设为群管理员？'), findsOneWidget);

    await tester.tap(find.text('设为管理员'));
    await tester.pumpAndSettle();

    expect(jsonDecode(roleBody!), {'role': 'admin'});
    expect(find.text('已设为群管理员'), findsOneWidget);
  });
}
