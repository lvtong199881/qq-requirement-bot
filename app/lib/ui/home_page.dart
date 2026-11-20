import 'package:flutter/material.dart';

import '../state/auth.dart';
import '../state/threads.dart';
import 'me_page.dart';
import 'thread_list_page.dart';

/// 登录后的主框架：下面两个 tab，上面各自是一套独立页面。
///
/// 用 IndexedStack 而不是每次切 tab 重建：需求列表在后台轮询，
/// 切到「我的」再切回来不该重新拉一遍、也不该丢滚动位置。
class HomePage extends StatefulWidget {
  const HomePage({super.key, required this.auth, required this.controller});

  final AuthController auth;
  final ThreadListController controller;

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  int _index = 0;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: IndexedStack(
        index: _index,
        children: [
          ThreadListPage(auth: widget.auth, controller: widget.controller),
          MePage(auth: widget.auth),
        ],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: (i) => setState(() => _index = i),
        destinations: const [
          NavigationDestination(
            icon: Icon(Icons.forum_outlined),
            selectedIcon: Icon(Icons.forum),
            label: '群',
          ),
          NavigationDestination(
            icon: Icon(Icons.person_outline),
            selectedIcon: Icon(Icons.person),
            label: '我的',
          ),
        ],
      ),
    );
  }
}
