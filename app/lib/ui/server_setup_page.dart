import 'package:flutter/material.dart';

import '../api/client.dart';
import '../state/auth.dart';
import 'scan_page.dart';

/// 配置服务器地址。
///
/// 这是整个 App 唯一的「安装向导」步骤：自建服务没有域名可写死，
/// 用户必须自己填。所以做得尽量宽容——不带协议也认，末尾斜杠也认。
/// 地址通常很长（Cloudflare 隧道域名尤其），输入框允许多行折行显示，
/// 而不是让用户在一个横向滚动的小格子里猜自己填全了没有。
class ServerSetupPage extends StatefulWidget {
  const ServerSetupPage({
    super.key,
    required this.auth,
    this.initialUrl,
    this.inSettings = false,
  });

  final AuthController auth;
  final String? initialUrl;

  /// 从「设置 → 服务器地址」进来。改完要退回根路由（登录页），
  /// 而不是把设置页留在栈顶。
  final bool inSettings;

  @override
  State<ServerSetupPage> createState() => _ServerSetupPageState();
}

class _ServerSetupPageState extends State<ServerSetupPage> {
  late final TextEditingController _url = TextEditingController(
    text: widget.initialUrl ?? '',
  );
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _url.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.auth.setServer(_url.text);
      if (!mounted) return;
      if (widget.inSettings) {
        // setServer 成功后 stage 变成 needLogin，根页面已经换成登录页；
        // 这里只需要把上面压着的设置/连接页弹掉。
        Navigator.of(context).popUntil((r) => r.isFirst);
      }
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _scan() async {
    final value = await Navigator.of(context).push<String>(
      MaterialPageRoute<String>(builder: (_) => const ScanPage()),
    );
    if (!mounted || value == null) return;
    final url = value.trim();
    if (url.isEmpty) return;
    setState(() {
      _url.text = url;
      _error = null;
    });
    await _submit();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('连接服务器')),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(20),
          children: [
            TextField(
              controller: _url,
              autofocus: true,
              enabled: !_busy,
              keyboardType: TextInputType.url,
              autocorrect: false,
              minLines: 1,
              maxLines: 4,
              textInputAction: TextInputAction.newline,
              decoration: const InputDecoration(
                labelText: '服务器地址',
                hintText: 'http://192.168.1.10:7881',
              ),
            ),
            if (_error != null) ...[
              const SizedBox(height: 12),
              _ErrorBox(message: _error!),
            ],
            const SizedBox(height: 20),
            Row(
              children: [
                Expanded(
                  child: FilledButton(
                    onPressed: _busy ? null : _submit,
                    child: _busy
                        ? const SizedBox(
                            width: 20,
                            height: 20,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Text('连接'),
                  ),
                ),
                const SizedBox(width: 10),
                OutlinedButton.icon(
                  onPressed: _busy ? null : _scan,
                  icon: const Icon(Icons.qr_code_scanner),
                  label: const Text('扫码'),
                ),
              ],
            ),
          ],
        ),
      ),
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
