package dev.karaoke;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;

@SpringBootApplication
@ConfigurationPropertiesScan
public class KaraokeApplication {

    public static void main(String[] args) {
        SpringApplication.run(KaraokeApplication.class, args);
    }
}
