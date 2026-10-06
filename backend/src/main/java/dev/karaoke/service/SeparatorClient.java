package dev.karaoke.service;

import java.net.http.HttpClient;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Map;

import org.springframework.core.ParameterizedTypeReference;
import org.springframework.http.MediaType;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

import dev.karaoke.config.KaraokeProperties;

/** Cliente HTTP do serviço Python (separator-service). */
@Component
public class SeparatorClient {

    private final RestClient client;

    public SeparatorClient(KaraokeProperties props) {
        var httpClient = HttpClient.newBuilder()
                .version(HttpClient.Version.HTTP_1_1)   // <- linha nova
                .connectTimeout(Duration.ofSeconds(5))
                .build();
        var factory = new JdkClientHttpRequestFactory(httpClient);
        factory.setReadTimeout(props.separator().readTimeout());
        this.client = RestClient.builder()
                .baseUrl(props.separator().url())
                .requestFactory(factory)
                .build();
    }

    /**
     * Separa o áudio e grava instrumental/lead/backing em outputDir.
     * Bloqueia até terminar. Devolve nome lógico -> nome do arquivo.
     */
    public Map<String, String> separate(Path input, Path outputDir) {
        Map<String, String> body = Map.of(
                "input_path", input.toAbsolutePath().toString(),
                "output_dir", outputDir.toAbsolutePath().toString());

        return client.post()
                .uri("/separate")
                .contentType(MediaType.APPLICATION_JSON)
                .body(body)
                .retrieve()
                .body(new ParameterizedTypeReference<Map<String, String>>() {
                });
    }
}
