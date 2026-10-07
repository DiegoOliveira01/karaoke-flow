package dev.karaoke.config;

import java.nio.file.Path;
import java.time.Duration;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "karaoke")
public record KaraokeProperties(Path storageDir, Separator separator, Itunes itunes) {

    public record Separator(String url, Duration readTimeout) {
    }

    /** País da loja do iTunes usada na busca de capas (ex.: BR, US). */
    public record Itunes(String country) {
    }

    public String itunesCountry() {
        return itunes == null || itunes.country() == null || itunes.country().isBlank() ? "BR" : itunes.country();
    }
}
