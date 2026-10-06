package dev.karaoke.service;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.stream.Stream;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;

import dev.karaoke.config.KaraokeProperties;
import dev.karaoke.model.Song;
import dev.karaoke.model.SongStatus;
import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;

@Service
public class SongService {

    private static final Logger log = LoggerFactory.getLogger(SongService.class);
    private static final String META = "meta.json";

    private final Path root;
    private final SeparatorClient separator;
    private final ObjectMapper mapper = new ObjectMapper()
            .registerModule(new JavaTimeModule())
            .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS)
            .enable(SerializationFeature.INDENT_OUTPUT);

    private final Map<String, Song> songs = new ConcurrentHashMap<>();
    // A GPU é o gargalo: uma música por vez.
    private final ExecutorService worker = Executors.newSingleThreadExecutor();

    public SongService(KaraokeProperties props, SeparatorClient separator) {
        this.root = props.storageDir().toAbsolutePath().normalize();
        this.separator = separator;
    }

    @PostConstruct
    void loadFromDisk() throws IOException {
        Files.createDirectories(root);
        try (Stream<Path> dirs = Files.list(root)) {
            dirs.filter(Files::isDirectory).forEach(dir -> {
                Path meta = dir.resolve(META);
                if (!Files.isRegularFile(meta)) {
                    return;
                }
                try {
                    Song song = mapper.readValue(meta.toFile(), Song.class);
                    songs.put(song.id(), song);
                    // O processo caiu no meio? Recoloca na fila.
                    if (song.status() == SongStatus.QUEUED || song.status() == SongStatus.SEPARATING) {
                        enqueue(song.withStatus(SongStatus.QUEUED));
                    }
                } catch (IOException e) {
                    log.warn("Ignorando {}: meta.json ilegível", dir, e);
                }
            });
        }
        log.info("{} música(s) carregada(s) de {}", songs.size(), root);
    }

    @PreDestroy
    void shutdown() {
        worker.shutdownNow();
    }

    public List<Song> list() {
        return songs.values().stream()
                .sorted(Comparator.comparing(Song::createdAt).reversed())
                .toList();
    }

    public Optional<Song> find(String id) {
        return Optional.ofNullable(songs.get(id));
    }

    public Song create(MultipartFile file, String title, String artist) {
        String original = file.getOriginalFilename() == null ? "audio" : file.getOriginalFilename();
        String id = UUID.randomUUID().toString();
        Path dir = root.resolve(id);
        try {
            Files.createDirectories(dir);
            file.transferTo(dir.resolve("original" + extensionOf(original)));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }

        String cleanTitle = (title == null || title.isBlank()) ? stripExtension(original) : title.trim();
        String cleanArtist = (artist == null || artist.isBlank()) ? "" : artist.trim();
        Song song = new Song(id, cleanTitle, cleanArtist, SongStatus.QUEUED, null, Instant.now(), Map.of());
        save(song);
        enqueue(song);
        return song;
    }

    public boolean delete(String id) {
        Song removed = songs.remove(id);
        if (removed == null) {
            return false;
        }
        Path dir = root.resolve(id);
        try (Stream<Path> walk = Files.walk(dir)) {
            walk.sorted(Comparator.reverseOrder()).forEach(p -> p.toFile().delete());
        } catch (IOException e) {
            log.warn("Não consegui apagar {}", dir, e);
        }
        return true;
    }

    // ------------------------------------------------------------------

    private void enqueue(Song song) {
        songs.put(song.id(), song);
        worker.submit(() -> process(song.id()));
    }

    private void process(String id) {
        Song song = songs.get(id);
        if (song == null) {
            return; // apagada enquanto esperava na fila
        }
        Path dir = root.resolve(id);
        try {
            save(song.withStatus(SongStatus.SEPARATING));
            Path input = findOriginal(dir);
            Map<String, String> files = separator.separate(input, dir);

            Song current = songs.get(id);
            if (current != null) { // pode ter sido apagada durante a separação
                save(current.withReady(files));
            }
        } catch (Exception e) {
            log.error("Falha ao processar {}", id, e);
            Song current = songs.get(id);
            if (current != null) {
                save(current.withError(e.getMessage()));
            }
        }
    }

    private void save(Song song) {
        songs.put(song.id(), song);
        Path dir = root.resolve(song.id());
        if (!Files.isDirectory(dir)) {
            return; // pasta apagada
        }
        try {
            mapper.writeValue(dir.resolve(META).toFile(), song);
        } catch (IOException e) {
            log.warn("Não consegui gravar meta.json de {}", song.id(), e);
        }
    }

    private static Path findOriginal(Path dir) throws IOException {
        try (Stream<Path> files = Files.list(dir)) {
            return files.filter(p -> p.getFileName().toString().startsWith("original."))
                    .findFirst()
                    .orElseThrow(() -> new IOException("Arquivo original não encontrado em " + dir));
        }
    }

    private static String extensionOf(String filename) {
        int dot = filename.lastIndexOf('.');
        if (dot < 0 || dot == filename.length() - 1) {
            return ".mp3";
        }
        String ext = filename.substring(dot).toLowerCase(Locale.ROOT);
        return ext.matches("\\.[a-z0-9]{1,5}") ? ext : ".mp3";
    }

    private static String stripExtension(String filename) {
        int dot = filename.lastIndexOf('.');
        return dot > 0 ? filename.substring(0, dot) : filename;
    }
}
