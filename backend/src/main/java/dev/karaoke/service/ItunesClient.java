package dev.karaoke.service;

import java.net.URI;
import java.net.http.HttpClient;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

import org.springframework.http.MediaType;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import dev.karaoke.config.KaraokeProperties;

/** Busca capas de álbum na iTunes Search API (gratuita, sem chave). */
@Component
public class ItunesClient {

    private static final long MAX_IMAGE_BYTES = 15L * 1024 * 1024;

    public record CoverResult(String album, String artist, String thumb, String url) {
    }

    public record Image(byte[] bytes, String extension) {
    }

    private final RestClient client;
    private final ObjectMapper mapper;
    private final String country;

    public ItunesClient(ObjectMapper mapper, KaraokeProperties props) {
        this.mapper = mapper;
        this.country = props.itunesCountry();
        var http = HttpClient.newBuilder()
                .version(HttpClient.Version.HTTP_1_1)
                .followRedirects(HttpClient.Redirect.NORMAL)
                .connectTimeout(Duration.ofSeconds(5))
                .build();
        var factory = new JdkClientHttpRequestFactory(http);
        factory.setReadTimeout(Duration.ofSeconds(20));
        this.client = RestClient.builder().requestFactory(factory).build();
    }

    public List<CoverResult> searchAlbums(String term) {
        // A API responde com Content-Type text/javascript, então lemos como texto e convertemos nós mesmos.
        String body = client.get()
                .uri("https://itunes.apple.com/search?term={t}&media=music&entity=album&limit=15&country={c}",
                        term, country)
                .retrieve()
                .body(String.class);
        List<CoverResult> results = new ArrayList<>();
        try {
            for (JsonNode n : mapper.readTree(body).path("results")) {
                String art = n.path("artworkUrl100").asText("");
                if (art.isBlank()) {
                    continue;
                }
                results.add(new CoverResult(
                        n.path("collectionName").asText(""),
                        n.path("artistName").asText(""),
                        resize(art, 300),
                        resize(art, 1200)));
            }
        } catch (Exception e) {
            throw new IllegalStateException("Resposta inesperada do iTunes", e);
        }
        return results;
    }

    /** Baixa a imagem escolhida. Só aceita https e o CDN da Apple (evita usar o servidor para acessar qualquer coisa). */
    public Image download(String url) {
        URI uri = URI.create(url);
        String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase(Locale.ROOT);
        boolean allowedHost = host.equals("mzstatic.com") || host.endsWith(".mzstatic.com");
        if (!"https".equalsIgnoreCase(uri.getScheme()) || !allowedHost) {
            throw new IllegalArgumentException("Endereço de imagem não permitido");
        }
        var response = client.get().uri(uri).retrieve().toEntity(byte[].class);
        byte[] bytes = response.getBody();
        MediaType type = response.getHeaders().getContentType();
        if (bytes == null || bytes.length == 0 || bytes.length > MAX_IMAGE_BYTES) {
            throw new IllegalArgumentException("Imagem vazia ou grande demais");
        }
        String ext;
        if (type != null && type.isCompatibleWith(MediaType.IMAGE_JPEG)) {
            ext = "jpg";
        } else if (type != null && type.isCompatibleWith(MediaType.IMAGE_PNG)) {
            ext = "png";
        } else if (type != null && "webp".equalsIgnoreCase(type.getSubtype())) {
            ext = "webp";
        } else {
            throw new IllegalArgumentException("Formato de imagem não suportado: " + type);
        }
        return new Image(bytes, ext);
    }

    private static String resize(String artworkUrl, int size) {
        return artworkUrl.replaceAll("/\\d+x\\d+bb\\.", "/" + size + "x" + size + "bb.");
    }
}
