package dev.karaoke.service;

import java.net.http.HttpClient;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

/** Cliente do LRCLIB (https://lrclib.net), banco gratuito de letras sincronizadas. */
@Component
public class LrclibClient {

    private static final Pattern TIMESTAMP = Pattern.compile("^(\\s*\\[[^\\]]*\\])+\\s*");

    public record LyricsResult(long id, String title, String artist, String album,
                               double duration, boolean synced, String preview) {
    }

    private final RestClient client;
    private final ObjectMapper mapper;

    public LrclibClient(ObjectMapper mapper) {
        this.mapper = mapper;
        var http = HttpClient.newBuilder()
                .version(HttpClient.Version.HTTP_1_1)
                .connectTimeout(Duration.ofSeconds(5))
                .build();
        var factory = new JdkClientHttpRequestFactory(http);
        factory.setReadTimeout(Duration.ofSeconds(20));
        this.client = RestClient.builder()
                .baseUrl("https://lrclib.net/api")
                .defaultHeader("User-Agent", "karaoke-local/0.2 (projeto pessoal)")
                .requestFactory(factory)
                .build();
    }

    public List<LyricsResult> search(String title, String artist) {
        String body;
        if (artist == null || artist.isBlank()) {
            body = client.get().uri("/search?track_name={t}", title).retrieve().body(String.class);
        } else {
            body = client.get().uri("/search?track_name={t}&artist_name={a}", title, artist)
                    .retrieve().body(String.class);
        }
        List<LyricsResult> results = new ArrayList<>();
        try {
            JsonNode array = mapper.readTree(body);
            for (JsonNode n : array) {
                String synced = text(n, "syncedLyrics");
                results.add(new LyricsResult(
                        n.path("id").asLong(),
                        text(n, "trackName"),
                        text(n, "artistName"),
                        text(n, "albumName"),
                        n.path("duration").asDouble(0),
                        !synced.isBlank(),
                        preview(synced)));
            }
        } catch (Exception e) {
            throw new IllegalStateException("Resposta inesperada do LRCLIB", e);
        }
        return results;
    }

    /** Devolve o texto LRC sincronizado (vazio se aquela letra não tiver sincronização). */
    public String fetchSynced(long id) {
        String body = client.get().uri("/get/{id}", id).retrieve().body(String.class);
        try {
            return text(mapper.readTree(body), "syncedLyrics");
        } catch (Exception e) {
            throw new IllegalStateException("Resposta inesperada do LRCLIB", e);
        }
    }

    private static String text(JsonNode n, String field) {
        JsonNode v = n.path(field);
        return v.isNull() || v.isMissingNode() ? "" : v.asText("");
    }

    /** Primeiras linhas sem os timestamps, só para o usuário reconhecer a música. */
    private static String preview(String lrc) {
        if (lrc.isBlank()) {
            return "";
        }
        List<String> lines = new ArrayList<>();
        for (String raw : lrc.split("\\R")) {
            String line = TIMESTAMP.matcher(raw).replaceFirst("").trim();
            if (!line.isEmpty()) {
                lines.add(line);
            }
            if (lines.size() == 3) {
                break;
            }
        }
        return String.join(" / ", lines);
    }
}
