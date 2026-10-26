package fr.nexify.app;

import java.io.IOException;
import java.util.List;
import java.util.Map;

import okhttp3.OkHttpClient;
import okhttp3.RequestBody;
import okhttp3.ResponseBody;

import org.schabi.newpipe.extractor.downloader.Downloader;
import org.schabi.newpipe.extractor.downloader.Request;
import org.schabi.newpipe.extractor.downloader.Response;
import org.schabi.newpipe.extractor.exceptions.ReCaptchaException;

/** Accès réseau de NewPipeExtractor, via OkHttp (même principe que l'appli NewPipe). */
public final class NpeDownloader extends Downloader {
    static final String USER_AGENT =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0";

    private final OkHttpClient client;

    NpeDownloader(final OkHttpClient client) {
        this.client = client;
    }

    @Override
    public Response execute(final Request request) throws IOException, ReCaptchaException {
        final byte[] data = request.dataToSend();
        final RequestBody body = data != null ? RequestBody.create(data) : null;
        final okhttp3.Request.Builder builder = new okhttp3.Request.Builder()
                .method(request.httpMethod(), body)
                .url(request.url())
                .addHeader("User-Agent", USER_AGENT);
        for (final Map.Entry<String, List<String>> h : request.headers().entrySet()) {
            builder.removeHeader(h.getKey());
            for (final String v : h.getValue()) {
                builder.addHeader(h.getKey(), v);
            }
        }
        try (okhttp3.Response r = client.newCall(builder.build()).execute()) {
            if (r.code() == 429) {
                throw new ReCaptchaException("reCaptcha demandé", request.url());
            }
            final ResponseBody rb = r.body();
            final String text = rb != null ? rb.string() : null;
            return new Response(r.code(), r.message(), r.headers().toMultimap(), text,
                    r.request().url().toString());
        }
    }
}
