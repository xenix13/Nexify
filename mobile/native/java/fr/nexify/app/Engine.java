package fr.nexify.app;

import java.io.InputStream;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import fi.iki.elonen.NanoHTTPD;
import okhttp3.OkHttpClient;
import okhttp3.ResponseBody;

import org.json.JSONArray;
import org.json.JSONObject;
import org.schabi.newpipe.extractor.Image;
import org.schabi.newpipe.extractor.InfoItem;
import org.schabi.newpipe.extractor.MediaFormat;
import org.schabi.newpipe.extractor.NewPipe;
import org.schabi.newpipe.extractor.ServiceList;
import org.schabi.newpipe.extractor.localization.ContentCountry;
import org.schabi.newpipe.extractor.localization.Localization;
import org.schabi.newpipe.extractor.search.SearchInfo;
import org.schabi.newpipe.extractor.services.youtube.linkHandler.YoutubeSearchQueryHandlerFactory;
import org.schabi.newpipe.extractor.stream.AudioStream;
import org.schabi.newpipe.extractor.stream.DeliveryMethod;
import org.schabi.newpipe.extractor.stream.StreamInfo;
import org.schabi.newpipe.extractor.stream.StreamInfoItem;

/**
 * Moteur local de l'appli Android : petit serveur HTTP sur 127.0.0.1 qui expose la même API
 * que le serveur Nexify pour la musique (flux audio et recherche YouTube Music), mais
 * récupère tout directement depuis le téléphone grâce à NewPipeExtractor.
 *
 *   GET /api/health
 *   GET /api/ytm/stream/{videoId}      (requêtes partielles « Range » : avance rapide)
 *   GET /api/search?q=...              ({ results: { ytm: { tracks } } })
 */
public final class Engine extends NanoHTTPD {
    private static final Pattern STREAM = Pattern.compile("^/api/ytm/stream/([A-Za-z0-9_-]{11})$");
    private static final Pattern VIDEO_ID = Pattern.compile("[?&]v=([A-Za-z0-9_-]{11})");
    private static final long URL_TTL = TimeUnit.HOURS.toMillis(4);

    private final OkHttpClient http;
    private final String version;
    private final Map<String, Resolved> cache = new ConcurrentHashMap<>();

    private static final class Resolved {
        final String url;
        final String mime;
        final long at = System.currentTimeMillis();

        Resolved(final String url, final String mime) {
            this.url = url;
            this.mime = mime;
        }
    }

    private static final class Status implements Response.IStatus {
        private final int code;
        private final String text;

        Status(final int code, final String text) {
            this.code = code;
            this.text = text;
        }

        @Override public String getDescription() { return code + " " + text; }
        @Override public int getRequestStatus() { return code; }
    }

    Engine(final String version) {
        super("127.0.0.1", 0);
        this.version = version;
        http = new OkHttpClient.Builder()
                .connectTimeout(15, TimeUnit.SECONDS)
                .readTimeout(30, TimeUnit.SECONDS)
                .build();
        NewPipe.init(new NpeDownloader(http), new Localization("fr", "FR"), new ContentCountry("FR"));
    }

    @Override
    public Response serve(final IHTTPSession session) {
        Response r;
        try {
            final String uri = session.getUri();
            final Matcher m = STREAM.matcher(uri);
            if (session.getMethod() == Method.OPTIONS) {
                r = newFixedLengthResponse(new Status(204, "No Content"), "text/plain", "");
            } else if ("/api/health".equals(uri)) {
                final JSONObject o = new JSONObject();
                o.put("ok", true);
                o.put("engine", "android");
                o.put("version", version);
                o.put("features", new JSONArray().put("stream").put("search"));
                r = json(200, o);
            } else if (m.matches()) {
                r = stream(m.group(1), session.getHeaders().get("range"), true);
            } else if ("/api/search".equals(uri)) {
                final List<String> q = session.getParameters().get("q");
                r = search(q == null || q.isEmpty() ? "" : q.get(0));
            } else {
                r = error(404, "Route inconnue");
            }
        } catch (final Exception e) {
            r = error(502, "Lecture impossible : " + e.getMessage());
        }
        r.addHeader("Access-Control-Allow-Origin", "*");
        r.addHeader("Access-Control-Allow-Headers", "authorization, content-type, range, x-nexify, x-nexify-client");
        r.addHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
        r.addHeader("Access-Control-Expose-Headers", "content-length, content-range, accept-ranges");
        return r;
    }

    // ---------- flux audio
    private Resolved resolve(final String id) throws Exception {
        final Resolved hit = cache.get(id);
        if (hit != null && System.currentTimeMillis() - hit.at < URL_TTL) {
            return hit;
        }
        final StreamInfo info = StreamInfo.getInfo(ServiceList.YouTube, "https://www.youtube.com/watch?v=" + id);
        AudioStream best = null;
        int bestScore = Integer.MIN_VALUE;
        for (final AudioStream a : info.getAudioStreams()) {
            if (a.getDeliveryMethod() != DeliveryMethod.PROGRESSIVE_HTTP || !a.isUrl()) {
                continue;
            }
            final int bitrate = a.getAverageBitrate() > 0 ? a.getAverageBitrate() : a.getBitrate() / 1000;
            // M4A d'abord : lu partout ; sinon Opus (WebM), très bien géré par Android
            final int score = (a.getFormat() == MediaFormat.M4A ? 100_000 : 0) + bitrate;
            if (score > bestScore) {
                bestScore = score;
                best = a;
            }
        }
        if (best == null) {
            throw new IllegalStateException("aucun flux audio disponible");
        }
        final String mime = best.getFormat() != null ? best.getFormat().getMimeType() : "audio/mp4";
        final Resolved res = new Resolved(best.getContent(), mime);
        cache.put(id, res);
        return res;
    }

    private Response stream(final String id, final String range, final boolean retry) throws Exception {
        final Resolved res = resolve(id);
        final okhttp3.Request.Builder rb = new okhttp3.Request.Builder()
                .url(res.url)
                .addHeader("User-Agent", NpeDownloader.USER_AGENT);
        if (range != null) {
            rb.addHeader("Range", range);
        }
        final okhttp3.Response up = http.newCall(rb.build()).execute();
        if ((up.code() == 403 || up.code() == 410) && retry) {
            up.close();
            cache.remove(id); // adresse expirée : on en redemande une
            return stream(id, range, false);
        }
        if (!up.isSuccessful()) {
            up.close();
            return error(502, "Flux YouTube : HTTP " + up.code());
        }
        final ResponseBody body = up.body();
        final InputStream in = body.byteStream();
        final long length = body.contentLength();
        final String type = up.header("Content-Type", res.mime);
        final Status status = up.code() == 206 ? new Status(206, "Partial Content") : new Status(200, "OK");
        final Response r = length >= 0
                ? newFixedLengthResponse(status, type, in, length)
                : newChunkedResponse(status, type, in);
        r.addHeader("Accept-Ranges", "bytes");
        r.addHeader("Cache-Control", "private, max-age=3600");
        final String cr = up.header("Content-Range");
        if (cr != null) {
            r.addHeader("Content-Range", cr);
        }
        return r;
    }

    // ---------- recherche YouTube Music (titres)
    private Response search(final String q) throws Exception {
        final JSONArray tracks = new JSONArray();
        if (!q.trim().isEmpty()) {
            final SearchInfo info = SearchInfo.getInfo(ServiceList.YouTube,
                    ServiceList.YouTube.getSearchQHFactory().fromQuery(q,
                            Collections.singletonList(YoutubeSearchQueryHandlerFactory.MUSIC_SONGS), ""));
            for (final InfoItem it : info.getRelatedItems()) {
                if (!(it instanceof StreamInfoItem)) {
                    continue;
                }
                final StreamInfoItem s = (StreamInfoItem) it;
                final Matcher m = VIDEO_ID.matcher(s.getUrl());
                if (!m.find()) {
                    continue;
                }
                final String id = m.group(1);
                String artist = s.getUploaderName() != null ? s.getUploaderName() : "";
                artist = artist.replaceAll("\\s+-\\s+Topic$", "");
                String art = "";
                int h = -1;
                for (final Image img : s.getThumbnails()) {
                    if (img.getHeight() > h || art.isEmpty()) {
                        h = img.getHeight();
                        art = img.getUrl();
                    }
                }
                final JSONObject t = new JSONObject();
                t.put("key", "ytm:" + id);
                t.put("source", "ytm");
                t.put("sourceId", id);
                t.put("title", s.getName());
                t.put("artists", new JSONArray().put(artist));
                t.put("album", "");
                t.put("duration", Math.max(0, s.getDuration()));
                t.put("artwork", art);
                t.put("previewUrl", "");
                t.put("uri", "https://music.youtube.com/watch?v=" + id);
                t.put("explicit", false);
                tracks.put(t);
            }
        }
        final JSONObject ytm = new JSONObject();
        ytm.put("tracks", tracks);
        ytm.put("hasMore", false);
        final JSONObject out = new JSONObject();
        out.put("q", q);
        out.put("results", new JSONObject().put("ytm", ytm));
        return json(200, out);
    }

    // ---------- utilitaires
    private static Response json(final int code, final JSONObject o) {
        return newFixedLengthResponse(new Status(code, code == 200 ? "OK" : "Error"),
                "application/json; charset=utf-8", o.toString());
    }

    private static Response error(final int code, final String message) {
        try {
            return json(code, new JSONObject().put("error", message));
        } catch (final Exception e) {
            return newFixedLengthResponse(new Status(code, "Error"), "text/plain", message);
        }
    }
}
