package dev.karaoke.config;

import java.nio.file.Path;
import java.time.Duration;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "karaoke")
public record KaraokeProperties(Path storageDir, Separator separator) {

    public record Separator(String url, Duration readTimeout) {
    }
}
