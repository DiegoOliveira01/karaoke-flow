package dev.karaoke.config;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.ResourceHandlerRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/** Serve os áudios das músicas em /media/{id}/arquivo. */
@Configuration
public class WebConfig implements WebMvcConfigurer {

    private final KaraokeProperties props;

    public WebConfig(KaraokeProperties props) {
        this.props = props;
    }

    @Override
    public void addResourceHandlers(ResourceHandlerRegistry registry) {
        String location = props.storageDir().toAbsolutePath().normalize().toUri().toString();
        registry.addResourceHandler("/media/**").addResourceLocations(location);
    }
}
