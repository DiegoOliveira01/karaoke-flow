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
        var httpClient = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).connectTimeout(Duration.ofSeconds(5)).build();
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

   /**
   * Alinha a letra (LRC) com a voz isolada e grava o words.json em output.
   * Bloqueia até terminar.
   *
   * offsetMs: deslocamento já detectado entre o LRC e o início real da voz
   *           (o mesmo que está em Song.lyricsOffsetMs). O worker usa isso
   *           para acertar a janela de áudio antes de alinhar.
   */
    public void align(Path audio, Path lrc, Path output, String language, int offsetMs) {
       Map<String, Object> body = new java.util.LinkedHashMap<>();
       body.put("audio_path", audio.toAbsolutePath().toString());
       body.put("lrc_path", lrc.toAbsolutePath().toString());
       body.put("output_path", output.toAbsolutePath().toString());
       body.put("language", language);
       body.put("offset_ms", offsetMs);

       client.post()
               .uri("/align")
               .contentType(MediaType.APPLICATION_JSON)
               .body(body)
               .retrieve()
               .toBodilessEntity();
   }

    /**
    * Pede ao serviço Python o deslocamento sugerido entre o início da voz no
    * lead.flac e a primeira linha da letra. Devolve um Map com "detected" e
    * "offsetMs" (além de "onsetMs"/"firstLyricMs" para diagnóstico).
    */
    public Map<String, Object> detectOffset(Path audio, Path lrc) {
        Map<String, String> body = Map.of(
                "audio_path", audio.toAbsolutePath().toString(),
                "lrc_path", lrc.toAbsolutePath().toString());

    return client.post()
            .uri("/detect-offset")
            .contentType(MediaType.APPLICATION_JSON)
            .body(body)
            .retrieve()
            .body(new ParameterizedTypeReference<Map<String, Object>>() {
            });
   }
}
