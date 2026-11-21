import 'package:flutter/foundation.dart';

import '../api/client.dart';
import '../api/models.dart';
import 'auth.dart';

/// 群设置页的数据：群本身（名字/群号）、成员列表、我能做什么。
///
/// 为什么不复用 ThreadDetailController：那边每 3 秒轮询消息，设置页不需要
/// 消息，也不需要轮询——成员变了再进来一次就好。混在一起会让详情页的
/// 轮询去拉一份永远没人看的成员表。
class GroupSettingsController extends ChangeNotifier {
  GroupSettingsController({
    required AuthController auth,
    required this.threadId,
    Thread? seed,
  }) : // 私有字段没法用初始化形参
       // ignore: prefer_initializing_formals
       _auth = auth,
       thread = seed;

  final AuthController _auth;
  final String threadId;

  ApiClient get _api => _auth.client;

  Thread? thread;
  GroupMembers? members;
  bool loading = true;
  String? error;

  /// 正在改名/改角色：按钮转圈用
  bool busy = false;

  bool get canRename => members?.canRename == true;
  bool get canManage => members?.canManage == true;

  /// 群名：优先用成员接口回来的 thread，其次用进页面时带的那份
  String get groupName {
    final n = thread?.groupName?.trim() ?? '';
    return n.isEmpty ? '未命名群' : n;
  }

  Future<void> start() => _load(initial: true);

  Future<void> _load({bool initial = false}) async {
    if (initial) {
      loading = true;
      error = null;
      notifyListeners();
    }
    try {
      // 两个接口都要；成员里有 canRename，决定改名入口能不能点
      final results = await Future.wait<Object?>([
        _api.thread(threadId),
        _api.groupMembers(threadId),
      ]);
      thread = results[0] as Thread;
      members = results[1] as GroupMembers;
      error = null;
    } on ApiException catch (e) {
      error = e.isNetwork ? '连不上服务器' : e.message;
    } finally {
      loading = false;
      notifyListeners();
    }
  }

  Future<void> refresh() => _load();

  /// 改群名。返回 null 表示成功，否则是要显示给用户的原因。
  Future<String?> rename(String name) async {
    final trimmed = name.trim();
    if (trimmed.isEmpty) return '群名不能为空';
    if (trimmed == groupName) return null;
    busy = true;
    notifyListeners();
    try {
      thread = await _api.renameGroup(threadId, trimmed);
      // 群名变了，列表页下次刷新才会看到；这里先把本地这份改掉
      return null;
    } on ApiException catch (e) {
      return e.isNetwork ? '连不上服务器' : e.message;
    } finally {
      busy = false;
      notifyListeners();
    }
  }

  /// 指定/取消群管理员。返回 null 表示成功。
  Future<String?> setRole(String userId, String role) async {
    busy = true;
    notifyListeners();
    try {
      members = GroupMembers(
        ownerId: members?.ownerId,
        canManage: members?.canManage ?? false,
        canRename: members?.canRename ?? false,
        members: await _api.setMemberRole(threadId, userId, role),
      );
      return null;
    } on ApiException catch (e) {
      return e.isNetwork ? '连不上服务器' : e.message;
    } finally {
      busy = false;
      notifyListeners();
    }
  }
}
