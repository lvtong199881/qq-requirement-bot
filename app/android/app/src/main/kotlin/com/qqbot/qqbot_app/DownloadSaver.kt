package com.qqbot.qqbot_app

import android.content.ContentValues
import android.os.Build
import android.os.Environment
import io.flutter.plugin.common.MethodChannel
import java.io.File
import java.io.FileOutputStream

/// 把下载的产物落到「外部目录」：用户在文件管理器/相册里直接能看到，
/// 而不是藏在 App 私有缓存里。
///
/// 权限设计（为什么这里没有运行时权限申请）：
/// - API 29+：走 MediaStore.Downloads / MediaStore.Images 集合插入。
///   应用对自己 insert 出来的条目天然拥有写权，不要求任何存储权限——
///   这是 scoped storage 的官方通路。
/// - API < 29：没有 Downloads 集合，直接写公共 Download 目录下的文件。
///   旧系统上这是共享存储，要 WRITE_EXTERNAL_STORAGE（Manifest 按
///   maxSdkVersion 28 声明，Android 10+ 的设备上这条权限不存在）。
object DownloadSaver {
    const val CHANNEL = "qqbot/download_saver"

    /// 保存字节到公共目录。返回对用户可读的保存位置描述。
    ///
    /// 图片走 MediaStore.Images（相册能直接显示）；其余按文档走
    /// MediaStore.Downloads（文件管理器的「下载」里）。
    fun save(context: android.content.Context, name: String, bytes: ByteArray): String {
        val safeName = name.replace(Regex("[\\\\/:*?\"<>|]"), "_")
        val isImage = Regex("\\.(png|jpe?g|gif|webp)$", RegexOption.IGNORE_CASE).containsMatchIn(safeName)

        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val collection = if (isImage) {
                android.provider.MediaStore.Images.Media.EXTERNAL_CONTENT_URI
            } else {
                android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI
            }
            // 相对路径带 qqbot 子目录：几十个产物混在系统下载根目录里找不到
            val relative = if (isImage) "Pictures/qqbot" else "Download/qqbot"
            val values = ContentValues().apply {
                put(android.provider.MediaStore.MediaColumns.DISPLAY_NAME, safeName)
                put(android.provider.MediaStore.MediaColumns.MIME_TYPE, mimeOf(safeName))
                put(android.provider.MediaStore.MediaColumns.RELATIVE_PATH, relative)
            }
            val uri = context.contentResolver.insert(collection, values)
                ?: throw IllegalStateException("MediaStore 插入失败")
            context.contentResolver.openOutputStream(uri)?.use { it.write(bytes) }
                ?: throw IllegalStateException("MediaStore 输出流打不开")
            "$relative/$safeName"
        } else {
            val dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
            val sub = File(dir, "qqbot").apply { mkdirs() }
            val file = File(sub, safeName)
            FileOutputStream(file).use { it.write(bytes) }
            // 让系统扫描器收录，图片才会出现在相册里
            android.media.MediaScannerConnection.scanFile(
                context, arrayOf(file.absolutePath), arrayOf(mimeOf(safeName)), null,
            )
            "Download/qqbot/$safeName"
        }
    }

    private fun mimeOf(name: String): String = when {
        name.endsWith(".png", true) -> "image/png"
        name.endsWith(".jpg", true) || name.endsWith(".jpeg", true) -> "image/jpeg"
        name.endsWith(".gif", true) -> "image/gif"
        name.endsWith(".webp", true) -> "image/webp"
        name.endsWith(".pdf", true) -> "application/pdf"
        name.endsWith(".zip", true) -> "application/zip"
        name.endsWith(".json", true) -> "application/json"
        else -> "application/octet-stream"
    }

    /// Dart 端注册入口，MainActivity 里一行调用。
    /// flutterEngine 是 FlutterActivity 的 protected 成员，所以注册逻辑
    /// 挂在 MainActivity.configureFlutterEngine 里，这里只收 handler。
    fun attach(activity: android.app.Activity, engine: io.flutter.embedding.engine.FlutterEngine) {
        MethodChannel(engine.dartExecutor.binaryMessenger, CHANNEL)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "save" -> {
                        val name = call.argument<String>("name") ?: "artifact.bin"
                        val bytes = call.argument<ByteArray>("bytes") ?: ByteArray(0)
                        try {
                            result.success(save(activity, name, bytes))
                        } catch (e: Exception) {
                            result.error("save_failed", e.message, null)
                        }
                    }
                    else -> result.notImplemented()
                }
            }
    }
}
