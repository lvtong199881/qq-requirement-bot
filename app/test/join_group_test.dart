import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:qqbot_app/state/threads.dart';
import 'package:qqbot_app/ui/thread_detail_page.dart';
import 'package:qqbot_app/ui/thread_list_page.dart';

import 'support.dart';

/// 入群这条路：列表页输群号（或扫码）→ 看群名人数 → 加入；
/// 以及被分享进群详情但还没加入时，详情页给的那个「加入」按钮。
void main() {
  testWidgets('列表页输群号能查到群并加入', (tester) async {
    bool joined = false;
    final auth = await readyAuth((req) async {
      switch (req.url.path) {
        case '/api/threads':
          return ok({
            'threads': [
              if (joined)
                {
                  'threadId': 't9',
                  'groupName': '产品讨论',
                  'mode': 'chat',
                  'pending': true,
                  'stages': [],
                },
            ],
            'botName': 'AI员工',
          });
        case '/api/engine/status':
          return ok({'online': true, 'botName': 'AI员工'});
        case '/api/threads/t9/preview':
          return ok({
            'preview': {
              'threadId': 't9',
              'groupName': '产品讨论',
              'memberCount': 3,
              'joined': joined,
              'ownerNickname': '产品阿宝',
            },
          });
        case '/api/threads/t9/join':
          joined = true;
          return ok({'joined': true});
        default:
          return ok({});
      }
    });
    final controller = ThreadListController(auth: auth);

    await tester.pumpWidget(
      MaterialApp(home: ThreadListPage(auth: auth, controller: controller)),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byTooltip('加入群'));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField), 't9');
    await tester.tap(find.text('查一下'));
    await tester.pumpAndSettle();

    // 先让人确认「这是哪个群、几个人」，再决定要不要进
    expect(find.text('产品讨论'), findsOneWidget);
    expect(find.text('3 个人'), findsOneWidget);

    await tester.tap(find.text('加入'));
    await tester.pumpAndSettle();

    expect(find.text('已加入「产品讨论」'), findsOneWidget);
    // 加完刷新列表，群出现在列表里
    expect(find.text('产品讨论'), findsWidgets);
  });

  testWidgets('群里没有你时，详情页给「加入这个群」', (tester) async {
    bool joined = false;
    final auth = await readyAuth((req) async {
      if (req.url.path == '/api/threads/t1/join') {
        joined = true;
        return ok({'joined': true});
      }
      if (req.url.path == '/api/threads/t1') {
        if (!joined) return failBody(403, '你还没加入这个群', code: 'not_member');
        return ok({
          'thread': {
            'threadId': 't1',
            'groupName': '产品讨论',
            'mode': 'chat',
            'pending': true,
            'stages': [],
          },
        });
      }
      if (req.url.path == '/api/threads/t1/messages') {
        if (!joined) return failBody(403, '你还没加入这个群', code: 'not_member');
        return ok({'messages': [], 'lastSeq': 0});
      }
      return ok({});
    });

    await tester.pumpWidget(
      MaterialApp(home: ThreadDetailPage(auth: auth, threadId: 't1')),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('还没进这个群'), findsOneWidget);

    await tester.tap(find.text('加入这个群'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('已加入这个群'), findsOneWidget);
    // 加入之后群名出现，说明拉到了详情
    expect(find.text('产品讨论'), findsWidgets);

    await tester.pumpWidget(const SizedBox.shrink());
  });
}
