package com.ldjx.accountmanager

import android.app.Activity
import android.content.Intent
import android.net.Uri
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewFeature
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class SubscribeEventsArgs {
    lateinit var channel: Channel
}

@InvokeArg
class OpenSessionArgs {
    var providerId: String = ""
    var providerName: String = ""
    var uuid: String = ""
    var alias: String = ""
    var entryUrl: String = ""
    var allowedHosts: Array<String> = emptyArray()
    var switchSeq: Long = 0L
    var viewInstanceId: Long = 0L
    var isColdStart: Boolean = false
}

@InvokeArg
class UpdateTitleArgs {
    var switchSeq: Long = 0L
    var title: String = ""
}

@InvokeArg
class CloseSessionArgs {
    var switchSeq: Long = 0L
}

@InvokeArg
class DeleteProfileArgs {
    var uuid: String = ""
}

@InvokeArg
class OpenExternalUrlArgs {
    var url: String = ""
}

@TauriPlugin
class AccountSessionPlugin(private val activity: Activity) : Plugin(activity) {

    @Command
    fun subscribeEvents(invoke: Invoke) {
        val args = invoke.parseArgs(SubscribeEventsArgs::class.java)
        AccountSessionCoordinator.setEventChannel(args.channel)
        invoke.resolve(JSObject())
    }

    @Command
    fun checkCapabilities(invoke: Invoke) {
        activity.runOnUiThread {
            try {
                val supported = WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)
                val profiles = JSArray()
                if (supported) {
                    for (name in ProfileStore.getInstance().allProfileNames) {
                        profiles.put(name)
                    }
                }
                val ret = JSObject().apply {
                    put("multiProfileSupported", supported)
                    put("profileNames", profiles)
                }
                invoke.resolve(ret)
            } catch (t: Throwable) {
                invoke.reject(t.message ?: "检测 Android WebView 能力异常")
            }
        }
    }

    @Command
    fun openAccountSession(invoke: Invoke) {
        val args = invoke.parseArgs(OpenSessionArgs::class.java)
        activity.runOnUiThread {
            if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
                invoke.reject("系统 WebView 不支持 MULTI_PROFILE")
                return@runOnUiThread
            }
            if (args.isColdStart) {
                val allNames = ProfileStore.getInstance().allProfileNames
                if (!allNames.contains(args.uuid)) {
                    invoke.reject("已提交账号的 Profile 不存在")
                    return@runOnUiThread
                }
            }

            val spec = AndroidAccountSessionSpec(
                providerId = args.providerId,
                providerName = args.providerName,
                uuid = args.uuid,
                alias = args.alias,
                entryUrl = args.entryUrl,
                allowedHosts = args.allowedHosts.toList(),
                switchSeq = args.switchSeq,
                viewInstanceId = args.viewInstanceId,
                isColdStart = args.isColdStart,
            )

            val existing = AccountSessionCoordinator.beginSession(spec)
            if (existing != null && !existing.isFinishing && !existing.isDestroyed) {
                existing.bindSessionSpec(spec)
            } else {
                val intent = Intent(activity, AccountWebActivity::class.java).apply {
                    addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
                }
                activity.startActivity(intent)
            }
            invoke.resolve(JSObject())
        }
    }

    @Command
    fun updateAccountTitle(invoke: Invoke) {
        val args = invoke.parseArgs(UpdateTitleArgs::class.java)
        activity.runOnUiThread {
            AccountSessionCoordinator.markCommittedAndReveal(args.switchSeq, args.title)
            invoke.resolve(JSObject())
        }
    }

    @Command
    fun closeActiveSession(invoke: Invoke) {
        val args = invoke.parseArgs(CloseSessionArgs::class.java)
        activity.runOnUiThread {
            val act = AccountSessionCoordinator.invalidateAndClose(args.switchSeq)
            act?.closeAndFinishFromManager()
            invoke.resolve(JSObject())
        }
    }

    @Command
    fun deleteProfile(invoke: Invoke) {
        val args = invoke.parseArgs(DeleteProfileArgs::class.java)
        activity.runOnUiThread {
            try {
                if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
                    invoke.resolve(JSObject())
                    return@runOnUiThread
                }
                if (AccountSessionCoordinator.isUuidActive(args.uuid)) {
                    invoke.reject("目标 Profile 视图尚未销毁")
                    return@runOnUiThread
                }
                val store = ProfileStore.getInstance()
                if (store.allProfileNames.contains(args.uuid)) {
                    val deleted = store.deleteProfile(args.uuid)
                    if (!deleted) {
                        invoke.reject("系统 Profile 正在被占用，待下次启动重试")
                        return@runOnUiThread
                    }
                }
                invoke.resolve(JSObject())
            } catch (t: Throwable) {
                invoke.reject(t.message ?: "删除 Android Profile 失败")
            }
        }
    }

    @Command
    fun openExternalUrl(invoke: Invoke) {
        val args = invoke.parseArgs(OpenExternalUrlArgs::class.java)
        activity.runOnUiThread {
            try {
                val intent = Intent(Intent.ACTION_VIEW, Uri.parse(args.url)).apply {
                    addCategory(Intent.CATEGORY_BROWSABLE)
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                activity.startActivity(intent)
                invoke.resolve(JSObject())
            } catch (t: Throwable) {
                invoke.reject(t.message ?: "无法调用系统浏览器打开链接")
            }
        }
    }
}
