package com.riseonemanshow.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.location.Location
import android.os.Build
import android.os.IBinder
import android.os.Looper
import android.webkit.CookieManager
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import org.json.JSONObject
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.time.Instant
import java.time.format.DateTimeFormatter
import java.util.ArrayDeque
import java.util.concurrent.Executors

/**
 * Foreground location service. While a trip is active it posts every accepted
 * GPS fix to the server IMMEDIATELY (real-time requirement) so the web app —
 * browser or this app — sees trip miles live from the one shared database.
 *
 * There is no local app database for customers or jobs: this service only
 * streams positions. If a post fails (offline), the fix stays queued in memory
 * and is retried with the next successful post. A 404 means the server has no
 * open trip for this call, so tracking stops.
 *
 * Started by MainActivity via the RiseNative.startTrip(callId) bridge and
 * stopped by RiseNative.stopTrip() or the notification's Stop action.
 */
class TripTrackingService : Service() {

    companion object {
        const val ACTION_START = "com.riseonemanshow.app.action.START_TRIP"
        const val ACTION_STOP = "com.riseonemanshow.app.action.STOP_TRIP"
        const val EXTRA_CALL_ID = "call_id"
        const val POSITIONS_URL = "https://riseonemanshow.com/app/native-positions"
        const val COOKIE_URL = "https://riseonemanshow.com"

        private const val NOTIFICATION_ID = 1
        private const val CHANNEL_ID = "trip_tracking"
        private const val MAX_ACCURACY_M = 50f
    }

    private lateinit var fused: FusedLocationProviderClient
    private var locationCallback: LocationCallback? = null
    private val executor = Executors.newSingleThreadExecutor()
    private val queue: ArrayDeque<String> = ArrayDeque()

    @Volatile
    private var callId: Int = -1

    @Volatile
    private var stopping = false

    override fun onCreate() {
        super.onCreate()
        fused = LocationServices.getFusedLocationProviderClient(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                val id = intent.getIntExtra(EXTRA_CALL_ID, -1)
                if (id < 0) {
                    stopSelf()
                    return START_NOT_STICKY
                }
                // A new trip replaces any previous one.
                try {
                    locationCallback?.let { fused.removeLocationUpdates(it) }
                } catch (e: Exception) {
                    // Never crash on cleanup.
                }
                synchronized(queue) { queue.clear() }
                callId = id
                stopping = false
                startForegroundWithNotification()
                startLocationUpdates()
            }
            ACTION_STOP -> {
                stopTracking()
                stopSelf()
            }
        }
        return START_NOT_STICKY
    }

    private fun startForegroundWithNotification() {
        val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Trip tracking",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Shows while trip miles are being tracked."
            }
            manager.createNotificationChannel(channel)
        }
        val stopIntent = Intent(this, TripTrackingService::class.java).apply {
            action = ACTION_STOP
        }
        val stopPending = PendingIntent.getService(
            this,
            0,
            stopIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val notification = Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("Rise One Man Show — Tracking trip miles")
            .setContentText(getString(R.string.tracking_notification_text))
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .addAction(Notification.Action.Builder(null, "Stop", stopPending).build())
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun startLocationUpdates() {
        val request = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 10_000L)
            .setMinUpdateIntervalMillis(5_000L)
            .setMinUpdateDistanceMeters(10f)
            .build()
        val callback = object : LocationCallback() {
            override fun onLocationResult(result: LocationResult) {
                for (location in result.locations) {
                    handleLocation(location)
                }
            }
        }
        locationCallback = callback
        try {
            fused.requestLocationUpdates(request, callback, Looper.getMainLooper())
        } catch (e: SecurityException) {
            // Permissions were revoked mid-trip: stop rather than crash.
            stopSelf()
        }
    }

    private fun handleLocation(location: Location) {
        if (stopping) return
        // Drop fixes with accuracy worse than 50m, and fixes with no accuracy.
        if (!location.hasAccuracy() || location.accuracy > MAX_ACCURACY_M) return
        val payload = JSONObject().apply {
            put("call_id", callId)
            put("lat", location.latitude)
            put("lng", location.longitude)
            put("accuracy_m", location.accuracy.toDouble())
            put(
                "recorded_at",
                DateTimeFormatter.ISO_INSTANT.format(Instant.ofEpochMilli(location.time))
            )
        }.toString()
        synchronized(queue) { queue.addLast(payload) }
        flushQueue()
    }

    private fun flushQueue() {
        try {
            executor.execute {
            while (true) {
                val payload: String
                synchronized(queue) {
                    payload = queue.peekFirst() ?: return@execute
                }
                when (val code = postPosition(payload)) {
                    in 200..299 -> {
                        synchronized(queue) { queue.removeFirst() }
                    }
                    404 -> {
                        // Server has no open trip for this call: stop tracking.
                        synchronized(queue) { queue.clear() }
                        stopTracking()
                        stopSelf()
                        return@execute
                    }
                    else -> {
                        // Offline or server error: keep queued, retry on next fix.
                        return@execute
                    }
                }
            }
            }
        } catch (e: Exception) {
            // Executor shut down (service destroyed) — never crash on a fix.
        }
    }

    /** Returns the HTTP status, or -1 on any transport failure. Never throws. */
    private fun postPosition(payload: String): Int {
        return try {
            val conn = (URL(POSITIONS_URL).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 10_000
                readTimeout = 15_000
                setRequestProperty("Content-Type", "application/json")
                val cookies = try {
                    CookieManager.getInstance().getCookie(COOKIE_URL)
                } catch (e: Exception) {
                    null
                }
                if (!cookies.isNullOrEmpty()) {
                    setRequestProperty("Cookie", cookies)
                }
                doOutput = true
            }
            OutputStreamWriter(conn.outputStream, Charsets.UTF_8).use { it.write(payload) }
            val code = conn.responseCode
            try {
                conn.inputStream?.close()
            } catch (e: Exception) {
            }
            try {
                conn.errorStream?.close()
            } catch (e: Exception) {
            }
            conn.disconnect()
            code
        } catch (e: Exception) {
            -1
        }
    }

    private fun stopTracking() {
        stopping = true
        try {
            locationCallback?.let { fused.removeLocationUpdates(it) }
        } catch (e: Exception) {
        }
        locationCallback = null
        if (Build.VERSION.SDK_INT >= 24) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
    }

    override fun onDestroy() {
        stopTracking()
        executor.shutdownNow()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
