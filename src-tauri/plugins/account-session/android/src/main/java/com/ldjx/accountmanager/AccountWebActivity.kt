package com.ldjx.accountmanager

import android.annotation.SuppressLint
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Message
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

class AccountWebActivity : AppCompatActivity() {

    private lateinit var headerTitleView: TextView
    private lateinit var mainWebContainer: FrameLayout
    private lateinit var loadingView: ProgressBar
    private lateinit var popupOverlayRoot: LinearLayout
    private lateinit var popupDomainLabel: TextView
    private lateinit var popupWebContainer: FrameLayout

    private var currentSpec: AndroidAccountSessionSpec? = null
    private var mainWebView: WebView? = null
    private var popupWebView: WebView? = null
    private var mainInputEnabled: Boolean = false
    private var popupInputEnabled: Boolean = false
    private var closingFromManager: Boolean = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        AccountSessionCoordinator.attachActivity(this)
        buildNativeHierarchy()

        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    if (popupWebView != null) {
                        destroyPopupWebView()
                        return
                    }
                    returnToAccountList()
                }
            },
        )

        val resolvedSpec = if (savedInstanceState != null) {
            AccountSessionCoordinator.recoverSpecOnActivityRecreate()
        } else {
            AccountSessionCoordinator.currentActiveSpec()
        }

        if (resolvedSpec == null) {
            closingFromManager = true
            finish()
            return
        }

        bindSessionSpec(resolvedSpec)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(Bundle())
    }

    override fun onDestroy() {
        val spec = currentSpec
        destroyPopupWebView()
        destroyMainWebView()
        AccountSessionCoordinator.detachActivity(this)
        if (!closingFromManager && isFinishing && spec != null) {
            AccountSessionCoordinator.emitActivityClosed(spec.switchSeq, spec.viewInstanceId)
        }
        super.onDestroy()
    }

    private fun dp(value: Int): Int {
        return TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP,
            value.toFloat(),
            resources.displayMetrics,
        ).toInt()
    }

    private fun buildNativeHierarchy() {
        val root = FrameLayout(this).apply {
            setBackgroundColor(Color.parseColor("#F7F7F7"))
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
        }

        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
        }

        val topBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(Color.parseColor("#EDEDED"))
            setPadding(dp(10), dp(6), dp(12), dp(6))
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(52),
            )
        }

        val backBtn = Button(this).apply {
            text = "← 账号"
            textSize = 13f
            isAllCaps = false
            setOnClickListener {
                if (popupWebView != null) {
                    destroyPopupWebView()
                } else {
                    returnToAccountList()
                }
            }
        }

        headerTitleView = TextView(this).apply {
            text = "正在核验会话…"
            setTextColor(Color.parseColor("#191919"))
            textSize = 15f
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
            setPadding(dp(10), 0, dp(10), 0)
            layoutParams = LinearLayout.LayoutParams(
                0,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                1f,
            )
        }

        topBar.addView(backBtn)
        topBar.addView(headerTitleView)

        val contentFrame = FrameLayout(this).apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                0,
                1f,
            )
        }

        loadingView = ProgressBar(this).apply {
            layoutParams = FrameLayout.LayoutParams(
                dp(36),
                dp(36),
                Gravity.CENTER,
            )
        }

        mainWebContainer = FrameLayout(this).apply {
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
        }

        contentFrame.addView(loadingView)
        contentFrame.addView(mainWebContainer)
        column.addView(topBar)
        column.addView(contentFrame)

        popupOverlayRoot = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            visibility = View.GONE
            setBackgroundColor(Color.WHITE)
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
        }

        val popupHeader = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(Color.parseColor("#1E1F22"))
            setPadding(dp(12), dp(6), dp(10), dp(6))
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(48),
            )
        }

        popupDomainLabel = TextView(this).apply {
            text = ""
            setTextColor(Color.WHITE)
            textSize = 13f
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
            layoutParams = LinearLayout.LayoutParams(
                0,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                1f,
            )
        }

        val closePopupBtn = Button(this).apply {
            text = "关闭认证"
            textSize = 12f
            isAllCaps = false
            setOnClickListener {
                destroyPopupWebView()
            }
        }

        popupHeader.addView(popupDomainLabel)
        popupHeader.addView(closePopupBtn)

        popupWebContainer = FrameLayout(this).apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                0,
                1f,
            )
        }

        popupOverlayRoot.addView(popupHeader)
        popupOverlayRoot.addView(popupWebContainer)

        root.addView(column)
        root.addView(popupOverlayRoot)
        setContentView(root)
    }

    @SuppressLint("SetJavaScriptEnabled", "ClickableViewAccessibility")
    fun bindSessionSpec(spec: AndroidAccountSessionSpec) {
        destroyPopupWebView()
        destroyMainWebView()

        currentSpec = spec
        mainInputEnabled = false
        headerTitleView.text = "正在核验会话…"
        loadingView.visibility = View.VISIBLE

        if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
            AccountSessionCoordinator.emitSessionFailed(
                spec.switchSeq,
                spec.viewInstanceId,
                "设备系统 WebView 不支持 MULTI_PROFILE",
            )
            closingFromManager = true
            finish()
            return
        }

        val wv = WebView(this)
        try {
            WebViewCompat.setProfile(wv, spec.uuid)
            val actualProfile = WebViewCompat.getProfile(wv).name
            if (actualProfile != spec.uuid) {
                wv.destroy()
                AccountSessionCoordinator.emitSessionFailed(
                    spec.switchSeq,
                    spec.viewInstanceId,
                    "Android WebView Profile 核对不匹配，已阻止加载",
                )
                closingFromManager = true
                finish()
                return
            }
        } catch (t: Throwable) {
            wv.destroy()
            AccountSessionCoordinator.emitSessionFailed(
                spec.switchSeq,
                spec.viewInstanceId,
                "绑定 Android WebView Profile 失败: ${t.message ?: "unknown"}",
            )
            closingFromManager = true
            finish()
            return
        }

        wv.visibility = View.INVISIBLE
        wv.isFocusable = false
        wv.isFocusableInTouchMode = false
        wv.setOnTouchListener { _, _ -> !mainInputEnabled }

        wv.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            setSupportMultipleWindows(true)
            javaScriptCanOpenWindowsAutomatically = false
            allowFileAccess = false
            allowContentAccess = false
        }

        wv.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest,
            ): Boolean {
                if (!request.isForMainFrame) {
                    return false
                }
                if (!AccountSessionCoordinator.isCurrent(spec.switchSeq, spec.viewInstanceId)) {
                    closeAndFinishFromManager()
                    return true
                }
                val uri = request.url
                if (AccountSessionCoordinator.isGoogleOAuthHost(uri)) {
                    AccountSessionCoordinator.emitExternalAuthUnavailable(
                        spec.switchSeq,
                        spec.viewInstanceId,
                        "Google OAuth 按政策需使用系统浏览器，当前回跳暂无法绑定至发起账号的独立 Profile，请使用邮箱或手机号登录",
                    )
                    return true
                }
                return !AccountSessionCoordinator.hostMatchesAllowed(uri, spec.allowedHosts)
            }

            override fun onPageCommitVisible(view: WebView, url: String) {
                if (!AccountSessionCoordinator.isCurrent(spec.switchSeq, spec.viewInstanceId)) {
                    closeAndFinishFromManager()
                    return
                }
                val boundName = try {
                    WebViewCompat.getProfile(view).name
                } catch (_: Throwable) {
                    ""
                }
                val uri = Uri.parse(url)
                if (boundName != spec.uuid ||
                    !AccountSessionCoordinator.hostMatchesAllowed(uri, spec.allowedHosts)
                ) {
                    AccountSessionCoordinator.emitSessionFailed(
                        spec.switchSeq,
                        spec.viewInstanceId,
                        "顶层页面来源或资料归属核验未通过，已回退管理页",
                    )
                    closeAndFinishFromManager()
                    return
                }

                AccountSessionCoordinator.emitPageCommitVisible(spec, url)
            }
        }

        wv.webChromeClient = object : WebChromeClient() {
            override fun onCreateWindow(
                view: WebView,
                isDialog: Boolean,
                isUserGesture: Boolean,
                resultMsg: Message?,
            ): Boolean {
                if (!isUserGesture || resultMsg == null || popupWebView != null) {
                    return false
                }
                if (!AccountSessionCoordinator.isCurrent(spec.switchSeq, spec.viewInstanceId)) {
                    return false
                }
                return createBoundAuthPopup(spec, resultMsg)
            }
        }

        mainWebView = wv
        mainWebContainer.addView(
            wv,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )
        wv.loadUrl(spec.entryUrl)
    }

    @SuppressLint("SetJavaScriptEnabled", "ClickableViewAccessibility")
    private fun createBoundAuthPopup(
        spec: AndroidAccountSessionSpec,
        resultMsg: Message,
    ): Boolean {
        val popup = WebView(this)
        try {
            WebViewCompat.setProfile(popup, spec.uuid)
            if (WebViewCompat.getProfile(popup).name != spec.uuid) {
                popup.destroy()
                return false
            }
        } catch (_: Throwable) {
            popup.destroy()
            return false
        }

        popupInputEnabled = false
        popup.visibility = View.INVISIBLE
        popup.isFocusable = false
        popup.isFocusableInTouchMode = false
        popup.setOnTouchListener { _, _ -> !popupInputEnabled }

        popup.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
            allowFileAccess = false
            allowContentAccess = false
        }

        popup.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest,
            ): Boolean {
                if (!request.isForMainFrame) {
                    return false
                }
                if (!AccountSessionCoordinator.isCurrent(spec.switchSeq, spec.viewInstanceId)) {
                    destroyPopupWebView()
                    return true
                }
                val uri = request.url
                if (uri.toString() == "about:blank") {
                    return false
                }
                if (AccountSessionCoordinator.isGoogleOAuthHost(uri)) {
                    destroyPopupWebView()
                    AccountSessionCoordinator.emitExternalAuthUnavailable(
                        spec.switchSeq,
                        spec.viewInstanceId,
                        "Google OAuth 按政策需使用系统浏览器，当前回跳暂无法绑定至发起账号的独立 Profile，请使用邮箱或手机号登录",
                    )
                    return true
                }
                if (!AccountSessionCoordinator.hostMatchesAllowed(uri, spec.allowedHosts)) {
                    destroyPopupWebView()
                    return true
                }
                return false
            }

            override fun onPageCommitVisible(view: WebView, url: String) {
                if (!AccountSessionCoordinator.isCurrent(spec.switchSeq, spec.viewInstanceId)) {
                    destroyPopupWebView()
                    return
                }
                if (url == "about:blank") {
                    return
                }
                val boundName = try {
                    WebViewCompat.getProfile(view).name
                } catch (_: Throwable) {
                    ""
                }
                val uri = Uri.parse(url)
                if (boundName != spec.uuid ||
                    !AccountSessionCoordinator.hostMatchesAllowed(uri, spec.allowedHosts)
                ) {
                    destroyPopupWebView()
                    return
                }
                val host = uri.host ?: ""
                popupDomainLabel.text = "认证域名 · $host"
                popupOverlayRoot.visibility = View.VISIBLE
                view.visibility = View.VISIBLE
                view.isFocusable = true
                view.isFocusableInTouchMode = true
                popupInputEnabled = true
            }
        }

        popup.webChromeClient = object : WebChromeClient() {
            override fun onCloseWindow(window: WebView?) {
                destroyPopupWebView()
            }
        }

        popupWebView = popup
        popupDomainLabel.text = ""
        popupOverlayRoot.visibility = View.GONE
        popupWebContainer.removeAllViews()
        popupWebContainer.addView(
            popup,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )

        val transport = resultMsg.obj as? WebView.WebViewTransport ?: run {
            destroyPopupWebView()
            return false
        }
        transport.webView = popup
        resultMsg.sendToTarget()
        return true
    }

    fun revealCommittedSession(switchSeq: Long, viewInstanceId: Long, title: String) {
        val spec = currentSpec ?: return
        if (spec.switchSeq != switchSeq || spec.viewInstanceId != viewInstanceId) {
            return
        }
        val wv = mainWebView ?: return
        headerTitleView.text = title
        loadingView.visibility = View.GONE
        wv.visibility = View.VISIBLE
        wv.isFocusable = true
        wv.isFocusableInTouchMode = true
        mainInputEnabled = true
    }

    fun closeAndFinishFromManager() {
        closingFromManager = true
        destroyPopupWebView()
        destroyMainWebView()
        if (!isFinishing) {
            finish()
        }
    }

    private fun returnToAccountList() {
        val spec = currentSpec
        closingFromManager = true
        destroyPopupWebView()
        destroyMainWebView()
        if (spec != null) {
            AccountSessionCoordinator.emitActivityClosed(spec.switchSeq, spec.viewInstanceId)
        }
        finish()
    }

    private fun destroyPopupWebView() {
        popupInputEnabled = false
        popupOverlayRoot.visibility = View.GONE
        popupDomainLabel.text = ""
        popupWebContainer.removeAllViews()
        popupWebView?.let { wv ->
            wv.stopLoading()
            wv.webChromeClient = null
            wv.destroy()
        }
        popupWebView = null
    }

    private fun destroyMainWebView() {
        mainInputEnabled = false
        mainWebContainer.removeAllViews()
        mainWebView?.let { wv ->
            wv.stopLoading()
            wv.webChromeClient = null
            wv.destroy()
        }
        mainWebView = null
    }
}
