package fr.nexify.app;

import android.content.Context;
import android.content.Intent;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import fi.iki.elonen.NanoHTTPD;

/** Pont entre l'interface Nexify et le moteur local (NewPipeExtractor) + notification de lecture. */
@CapacitorPlugin(name = "NexifyEngine")
public class NexifyEnginePlugin extends Plugin {
    private static Engine engine;

    @PluginMethod
    public void start(final PluginCall call) {
        new Thread(() -> {
            try {
                synchronized (NexifyEnginePlugin.class) {
                    if (engine == null || !engine.isAlive()) {
                        final Context ctx = getContext();
                        String version = "";
                        try {
                            version = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0).versionName;
                        } catch (final Exception ignored) {
                            // version facultative
                        }
                        final Engine e = new Engine(version);
                        e.start(NanoHTTPD.SOCKET_READ_TIMEOUT, true);
                        engine = e;
                    }
                }
                final JSObject r = new JSObject();
                r.put("port", engine.getListeningPort());
                call.resolve(r);
            } catch (final Exception ex) {
                call.reject("Moteur local indisponible : " + ex.getMessage());
            }
        }).start();
    }

    @PluginMethod
    public void playback(final PluginCall call) {
        final Context ctx = getContext();
        final boolean playing = Boolean.TRUE.equals(call.getBoolean("playing", false));
        final String title = call.getString("title", "Nexify");
        final String artist = call.getString("artist", "");
        try {
            if (playing) {
                if (PlaybackService.running) {
                    PlaybackService.update(ctx, title, artist);
                } else {
                    final Intent i = new Intent(ctx, PlaybackService.class);
                    i.putExtra("title", title);
                    i.putExtra("artist", artist);
                    ContextCompat.startForegroundService(ctx, i);
                }
            } else if (PlaybackService.running) {
                ctx.stopService(new Intent(ctx, PlaybackService.class));
            }
        } catch (final Exception ignored) {
            // Android peut refuser de démarrer le service depuis l'arrière-plan : la lecture continue
        }
        call.resolve();
    }
}
