package com.qqbot.qqbot_app

import android.content.Context
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.text.TextUtils
import android.view.Gravity
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/// 原生 toast：Dart 侧 NativeToast 调过来，统一「上图标下文案」的竖排样式。
///
/// 为什么自己拼 View 而不是只用 Toast.makeText：系统默认 toast 是
/// 「左图标右文字」，和 iOS 端/设计的「上图标下文案」对不上；
/// 拼一个竖排 LinearLayout 两端样式才能一致。
///
/// Toast.setView 在 API 30 起标记 deprecated，但至今（API 35）仍然可用，
/// 没有替代 API 能拿到同样的「任意 View + 全局浮层」效果，故继续使用；
/// 真被移除的那天再整体换成应用内浮层方案。
object NativeToastHost {
    const val CHANNEL = "qqbot/toast"

    /// loading 是常驻的，要留着引用等 hideLoading 来收
    private var loadingToast: Toast? = null

    fun attach(activity: android.app.Activity, engine: FlutterEngine) {
        MethodChannel(engine.dartExecutor.binaryMessenger, CHANNEL)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "show" -> {
                        val text = call.argument<String>("text") ?: ""
                        val type = call.argument<String>("type")
                        show(activity, text, type)
                        result.success(null)
                    }
                    "showLoading" -> {
                        val text = call.argument<String>("text") ?: ""
                        showLoading(activity, text)
                        result.success(null)
                    }
                    "hideLoading" -> {
                        loadingToast?.cancel()
                        loadingToast = null
                        result.success(null)
                    }
                    else -> result.notImplemented()
                }
            }
    }

    /// 会自动消失的 toast；type 为 null 时是纯文本样式，否则带对应图标。
    fun show(context: Context, text: String, type: String?) {
        val toast = Toast.makeText(context, text, Toast.LENGTH_LONG)
        toast.setView(buildView(context, text, type, loading = false))
        // 造过自定义 view 后系统会保留原 text 用于无障碍，位置用默认的
        // 居中偏下即可，不用额外 setGravity（部分 ROM 对自定义 view 的
        // gravity 支持不稳，交给系统默认最省事）。
        toast.show()
    }

    /// 常驻 loading：不设时长上限，必须 hideLoading 收。
    fun showLoading(context: Context, text: String) {
        loadingToast?.cancel()
        val toast = Toast.makeText(context, text, Toast.LENGTH_LONG)
        toast.setView(buildView(context, text, null, loading = true))
        toast.show()
        loadingToast = toast
    }

    private fun buildView(context: Context, text: String, type: String?, loading: Boolean): android.view.View {
        val pad = (16 * context.resources.displayMetrics.density).toInt()
        val col = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            // 圆角黑底：透明 toast 上系统还会再包一层背景，自己画才能保证圆角
            background = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = 12 * context.resources.displayMetrics.density
                setColor(Color.argb(230, 32, 33, 36))
            }
            setPadding(pad, pad, pad, pad)
        }

        // 第一行：图标（或 loading 转圈）
        if (loading) {
            val bar = ProgressBar(context).apply {
                // indeterminate 白色转圈：Tint 包一层才能在深色底上看清
                indeterminateTintList = android.content.res.ColorStateList.valueOf(Color.WHITE)
            }
            col.addView(bar, LinearLayout.LayoutParams(dp(context, 28), dp(context, 28)).apply {
                gravity = Gravity.CENTER_HORIZONTAL
            })
        } else {
            val iconRes = when (type) {
                "info" -> R.drawable.ic_toast_info
                "warning" -> R.drawable.ic_toast_warning
                "error" -> R.drawable.ic_toast_error
                else -> null
            }
            if (iconRes != null) {
                val icon = android.widget.ImageView(context).apply {
                    setImageResource(iconRes)
                    // 图标本身画的就是白色（单色 path），不用再 tint
                }
                col.addView(icon, LinearLayout.LayoutParams(dp(context, 28), dp(context, 28)).apply {
                    gravity = Gravity.CENTER_HORIZONTAL
                })
            }
        }

        // 第二行：文案
        val label = TextView(context).apply {
            this.text = text
            setTextColor(Color.WHITE)
            textSize = 15f
            maxLines = 4
            ellipsize = TextUtils.TruncateAt.END
            gravity = Gravity.CENTER
        }
        val textParams = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT,
        ).apply { gravity = Gravity.CENTER_HORIZONTAL }
        if (!loading && iconOrLoadingShown(type, loading)) {
            textParams.topMargin = dp(context, 8)
        }
        col.addView(label, textParams)
        return col
    }

    private fun iconOrLoadingShown(type: String?, loading: Boolean): Boolean =
        loading || type in setOf("info", "warning", "error")

    private fun dp(context: Context, v: Int): Int = (v * context.resources.displayMetrics.density).toInt()
}
