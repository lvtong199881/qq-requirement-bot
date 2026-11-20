import 'package:flutter/material.dart';

import '../api/client.dart';
import '../state/auth.dart';
import 'server_setup_page.dart';

/// 登录 / 注册。
///
/// 一个页面两个模式而不是两个路由：注册就是多两个字段，做完立刻登录，
/// 跳来跳去反而让人搞不清自己现在在哪一步。
class LoginPage extends StatefulWidget {
  const LoginPage({super.key, required this.auth});

  final AuthController auth;

  @override
  State<LoginPage> createState() => _LoginPageState();
}

class _LoginPageState extends State<LoginPage> {
  final _formKey = GlobalKey<FormState>();
  late final TextEditingController _username = TextEditingController(
    text: widget.auth.lastUsername ?? '',
  );
  final _password = TextEditingController();
  final _nickname = TextEditingController();

  bool _registering = false;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _username.dispose();
    _password.dispose();
    _nickname.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!(_formKey.currentState?.validate() ?? false)) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      if (_registering) {
        await widget.auth.register(
          username: _username.text.trim(),
          password: _password.text,
          nickname: _nickname.text.trim(),
        );
      } else {
        await widget.auth.login(
          username: _username.text.trim(),
          password: _password.text,
        );
      }
      // 成功后 stage 变 ready，根 Widget 自动换页
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(
        title: Text(_registering ? '注册' : '登录'),
        actions: [
          IconButton(
            tooltip: '换服务器',
            icon: const Icon(Icons.dns_outlined),
            onPressed: _busy
                ? null
                : () => Navigator.of(context).push(
                    MaterialPageRoute<void>(
                      builder: (_) => ServerSetupPage(
                        auth: widget.auth,
                        initialUrl: widget.auth.baseUrl,
                      ),
                    ),
                  ),
          ),
        ],
      ),
      body: SafeArea(
        child: Form(
          key: _formKey,
          child: ListView(
            padding: const EdgeInsets.fromLTRB(20, 24, 20, 32),
            children: [
              Text(
                _registering ? '建个账号' : '欢迎回来',
                style: theme.textTheme.headlineSmall?.copyWith(
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(height: 6),
              Text(
                widget.auth.baseUrl,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
              const SizedBox(height: 28),

              TextFormField(
                controller: _username,
                enabled: !_busy,
                autocorrect: false,
                textInputAction: TextInputAction.next,
                decoration: const InputDecoration(labelText: '用户名'),
                validator: (v) {
                  final s = (v ?? '').trim();
                  if (s.isEmpty) return '填个用户名';
                  if (s.length < 2) return '至少 2 个字';
                  if (s.length > 20) return '最多 20 个字';
                  return null;
                },
              ),
              const SizedBox(height: 14),
              TextFormField(
                controller: _password,
                enabled: !_busy,
                obscureText: true,
                textInputAction: _registering ? TextInputAction.next : TextInputAction.done,
                decoration: const InputDecoration(labelText: '密码'),
                validator: (v) {
                  final s = v ?? '';
                  if (s.isEmpty) return '填个密码';
                  if (_registering && s.length < 6) return '至少 6 位';
                  return null;
                },
                onFieldSubmitted: (_) {
                  if (!_registering && !_busy) _submit();
                },
              ),
              if (_registering) ...[
                const SizedBox(height: 14),
                TextFormField(
                  controller: _nickname,
                  enabled: !_busy,
                  decoration: const InputDecoration(
                    labelText: '昵称（选填）',
                    helperText: '列表和消息里显示这个名字',
                  ),
                ),
              ],

              if (_error != null) ...[
                const SizedBox(height: 16),
                _ErrorBox(message: _error!),
              ],

              const SizedBox(height: 24),
              FilledButton(
                onPressed: _busy ? null : _submit,
                child: _busy
                    ? const SizedBox(
                        width: 20,
                        height: 20,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : Text(_registering ? '注册并登录' : '登录'),
              ),
              const SizedBox(height: 12),
              TextButton(
                onPressed: _busy
                    ? null
                    : () => setState(() {
                        _registering = !_registering;
                        _error = null;
                      }),
                child: Text(_registering ? '我有账号，去登录' : '没有账号，注册一个'),
              ),

              if (_registering) ...[
                const SizedBox(height: 20),
                _Note(
                  '第一个注册的人会成为系统管理员。admin 才能发起需求和点通过/打回。',
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class _Note extends StatelessWidget {
  const _Note(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(Icons.info_outline, size: 16, color: theme.colorScheme.onSurfaceVariant),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            text,
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
              height: 1.5,
            ),
          ),
        ),
      ],
    );
  }
}

class _ErrorBox extends StatelessWidget {
  const _ErrorBox({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: scheme.errorContainer,
        borderRadius: BorderRadius.circular(10),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.error_outline, size: 18, color: scheme.onErrorContainer),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              message,
              style: TextStyle(color: scheme.onErrorContainer, fontSize: 13),
            ),
          ),
        ],
      ),
    );
  }
}
