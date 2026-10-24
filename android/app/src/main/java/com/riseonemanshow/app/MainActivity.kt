package com.riseonemanshow.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat

/**
 * Loads the Rise One Man Show web app in a WebView. There is NO local app
 * database: the user logs in with the same account as the browser and all
 * customers, jobs, and trips live in the one shared server database.
 *
 * The web side calls the "RiseNative" JavaScript interface when a travel leg
 * starts/stops so trip miles keep tracking in the background.
 */
class MainActivity : AppCompatActivity() {

    companion object {
        const val HOME_URL = "https://riseonemanshow.com"
    }

    private lateinit var webView: WebView
    private var pendingCallId: Int? = null

    private val fineLocationLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { grants ->
            if (grants[Manifest.permission.ACCESS_FINE_LOCATION] == true) {
                onFineLocationGranted()
            } else {
                Toast.makeText(this, R.string.location_denied, Toast.LENGTH_LONG).show()
            }
        }

    private val backgroundLocationLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            val callId = pendingCallId
            pendingCallId = null
            if (granted && callId != null) {
                startTripService(callId)
            } else if (!granted) {
                Toast.makeText(this, R.string.background_declined, Toast.LENGTH_LONG).show()
            }
        }

    private val notificationLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* best effort only */ }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        // Initialize the cookie store on the UI thread so the tracking service
        // can later read the WebView session cookies for authenticated posts.
        CookieManager.getInstance().setAcceptCookie(true)

        webView = findViewById(R.id.webview)
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.settings.databaseEnabled = true
        webView.settings.setGeolocationEnabled(true)
        webView.addJavascriptInterface(NativeBridge(), "RiseNative")
        webView.webViewClient = object : WebViewClient() {
            // Returning false keeps every navigation inside this WebView.
            override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean = false
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onGeolocationPermissionsShowPrompt(
                origin: String,
                callback: GeolocationPermissions.Callback
            ) {
                // Grant the page geolocation ONLY once fine location is granted.
                if (hasFineLocation()) {
                    callback.invoke(origin, true, false)
                } else {
                    callback.invoke(origin, false, false)
                    fineLocationLauncher.launch(
                        arrayOf(
                            Manifest.permission.ACCESS_FINE_LOCATION,
                            Manifest.permission.ACCESS_COARSE_LOCATION
                        )
                    )
                }
            }
        }

        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            notificationLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }

        if (savedInstanceState == null) {
            webView.loadUrl(HOME_URL)
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    override fun onRestoreInstanceState(savedInstanceState: Bundle) {
        super.onRestoreInstanceState(savedInstanceState)
        webView.restoreState(savedInstanceState)
    }

    private fun hasFineLocation(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED

    private fun hasBackgroundLocation(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_BACKGROUND_LOCATION) ==
            PackageManager.PERMISSION_GRANTED

    private fun onFineLocationGranted() {
        val callId = pendingCallId
        if (callId == null) return // permission was for the WebView prompt, not a trip
        if (hasBackgroundLocation()) {
            pendingCallId = null
            startTripService(callId)
        } else {
            showBackgroundDisclosure()
        }
    }

    private fun handleStartTrip(callId: Int) {
        pendingCallId = callId
        when {
            !hasFineLocation() -> fineLocationLauncher.launch(
                arrayOf(
                    Manifest.permission.ACCESS_FINE_LOCATION,
                    Manifest.permission.ACCESS_COARSE_LOCATION
                )
            )
            !hasBackgroundLocation() -> showBackgroundDisclosure()
            else -> {
                pendingCallId = null
                startTripService(callId)
            }
        }
    }

    private fun handleStopTrip() {
        pendingCallId = null
        val intent = Intent(this, TripTrackingService::class.java).apply {
            action = TripTrackingService.ACTION_STOP
        }
        startService(intent)
    }

    /**
     * Prominent disclosure shown BEFORE background location is ever requested,
     * in plain words, per Play policy for background location access.
     */
    private fun showBackgroundDisclosure() {
        AlertDialog.Builder(this)
            .setTitle(R.string.disclosure_title)
            .setMessage(R.string.disclosure_message)
            .setPositiveButton(R.string.disclosure_allow) { _, _ ->
                backgroundLocationLauncher.launch(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
            }
            .setNegativeButton(R.string.disclosure_not_now) { _, _ ->
                pendingCallId = null
            }
            .setCancelable(false)
            .show()
    }

    private fun startTripService(callId: Int) {
        val intent = Intent(this, TripTrackingService::class.java).apply {
            action = TripTrackingService.ACTION_START
            putExtra(TripTrackingService.EXTRA_CALL_ID, callId)
        }
        startForegroundService(intent)
    }

    /**
     * Called from the web app: RiseNative.startTrip(callId) when a travel leg
     * starts, RiseNative.stopTrip() when the job starts (travel ends).
     * Runs on a WebView thread, so all UI/permission work is posted to the UI thread.
     */
    inner class NativeBridge {
        @JavascriptInterface
        fun isNative(): Boolean = true

        @JavascriptInterface
        fun startTrip(callId: Int) {
            runOnUiThread { handleStartTrip(callId) }
        }

        @JavascriptInterface
        fun stopTrip() {
            runOnUiThread { handleStopTrip() }
        }
    }
}
