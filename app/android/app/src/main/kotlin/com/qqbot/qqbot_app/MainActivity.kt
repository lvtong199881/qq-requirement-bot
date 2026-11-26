package com.qqbot.qqbot_app

import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine

class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        // 原生 toast 通道：Dart 侧 NativeToast.show/showLoading/hideLoading
        NativeToastHost.attach(this, flutterEngine)
    }
}
