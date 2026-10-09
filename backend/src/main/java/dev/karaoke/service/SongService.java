package dev.karaoke.service;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.UnaryOperator;
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
import dev.karaoke.model.WordsFile;
import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;

@Service
public class SongService {

    private static final Logger log = LoggerFactory.getLogger(SongService.class);
    private static final String META = "meta.json";

    private final YtDlpClient ytdlp;

    private final Path root;
    private final SeparatorClient separator;
    private final ObjectMapper mapper = new ObjectMapper()
            .registerModule(new JavaTimeModule())
            .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS)
            .enable(SerializationFeature.INDENT_OUTPUT);

    private final ObjectMapper compactMapper = mapper.copy().disable(SerializationFeature.INDENT_OUTPUT);

    private final Map<String, Song> songs = new ConcurrentHashMap<>();
    // A GPU é o gargalo: uma música por vez.
    private final ExecutorService worker = Executors.newSingleThreadExecutor();

    public SongService(KaraokeProperties props, SeparatorClient separator, YtDlpClient ytdlp) {
        this.root = props.storageDir().toAbsolutePath().normalize();
        this.separator = separator;
        this.ytdlp = ytdlp;
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
                    if (Song.WORDS_RUNNING.equals(song.wordsState())) {
                        song = song.withWordsState(null, null); // o alinhamento morreu com o processo
                    }
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
        Song song = Song.queued(id, cleanTitle, cleanArtist);
        persist(song);
        enqueue(song);
        return song;
    }

    /**
    * Baixa o áudio de uma URL do YouTube (ou do primeiro resultado de uma busca)
    * e enfileira a música para separação.
    *
    * O arquivo baixado vira "original.mp3" dentro da pasta da música, que é o
    * mesmo nome que o upload multipart produz — então o resto do pipeline
    * (findOriginal, separator, etc.) não precisa saber que a origem foi o yt-dlp.
    */
    public Song createFromUrl(String urlOrQuery) {
        String id = UUID.randomUUID().toString();
        Path dir = root.resolve(id);
        try {
            Files.createDirectories(dir);

            // 1) Consulta metadados (título / uploader) sem baixar o arquivo inteiro.
            YtDlpClient.Metadata meta = ytdlp.probe(urlOrQuery);

            // 2) Baixa o áudio como original.mp3.
            ytdlp.download(urlOrQuery, dir.resolve("original"));

            // 3) Confere que o arquivo existe mesmo.
            Path audio;
            try (Stream<Path> files = Files.list(dir)) {
                audio = files
                        .filter(p -> p.getFileName().toString().startsWith("original."))
                        .findFirst()
                        .orElse(null);
            }
            if (audio == null) {
                throw new IOException("yt-dlp não gerou nenhum arquivo de áudio em " + dir);
            }

            String cleanTitle = (meta.title() == null || meta.title().isBlank())
                    ? "Música " + id.substring(0, 8)
                    : meta.title().trim();
            String cleanArtist = meta.artist() == null ? "" : meta.artist().trim();

            Song song = Song.queued(id, cleanTitle, cleanArtist);
            persist(song);
            enqueue(song);
            return song;
        } catch (Exception e) {
            // Falhou: apaga a pasta meio-feita para não deixar lixo.
            try (Stream<Path> walk = Files.walk(dir)) {
                walk.sorted(Comparator.reverseOrder()).forEach(p -> p.toFile().delete());
            } catch (IOException ignored) {
                 // já estamos em erro; não vale a pena propagar esse segundo problema
            }
            throw new UncheckedIOException(new IOException(
                    "Falha ao baixar do YouTube: " + e.getMessage(), e));
        }
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

    // ---------------------------------------------------------------- letra / capa

    public Optional<Song> attachLyrics(String id, String lrc) {
    if (!songs.containsKey(id)) {
        return Optional.empty();
    }
    Path dir = root.resolve(id);
    try {
        Files.writeString(dir.resolve("lyrics.lrc"), lrc, StandardCharsets.UTF_8);
        Files.deleteIfExists(dir.resolve("words.json")); // era da letra anterior
    } catch (IOException e) {
        throw new UncheckedIOException(e);
    }

    // 1) Aplica a letra (reseta offset e palavras, como antes).
    Song afterLyrics = songs.computeIfPresent(id, (k, s) -> s.withFile("lyrics", "lyrics.lrc"));
    if (afterLyrics == null) {
        return Optional.empty();
    }

    // 2) Tenta medir o offset entre a primeira linha cantada e o início da voz.
    int offset = detectOffsetSafe(dir, afterLyrics);
    if (offset != 0) {
        afterLyrics = songs.computeIfPresent(id, (k, s) -> s.withLyricsOffset(offset));
        if (afterLyrics == null) {
            return Optional.empty();
        }
    }

    persist(afterLyrics);
    return Optional.of(afterLyrics);
}

    /** Tenta detectar o offset; devolve 0 se não der ou se for desprezível. */
    private int detectOffsetSafe(Path dir, Song song) {
        String lead = song.files().get("lead");
        if (lead == null) {
            return 0; // separação ainda não terminou
        }
        try {
            var info = separator.detectOffset(dir.resolve(lead), dir.resolve("lyrics.lrc"));
            Object detected = info.get("detected");
            Object value = info.get("offsetMs");
            if (Boolean.TRUE.equals(detected) && value instanceof Number n) {
                int ms = n.intValue();
                // Abaixo de 100 ms é imperceptível; não mexe.
                return Math.abs(ms) >= 100 ? ms : 0;
            }
        } catch (Exception e) {
            log.warn("Não consegui detectar offset automático de {}: {}", song.id(), e.getMessage());
        }
        return 0;
    }

    public Optional<Song> attachCover(String id, byte[] bytes, String extension) {
        if (!songs.containsKey(id)) {
            return Optional.empty();
        }
        Path dir = root.resolve(id);
        String name = "cover." + extension;
        try {
            // remove capa antiga (pode ter outra extensão)
            try (Stream<Path> old = Files.list(dir)) {
                old.filter(p -> p.getFileName().toString().startsWith("cover.")).forEach(p -> p.toFile().delete());
            }
            Files.write(dir.resolve(name), bytes);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
        return update(id, s -> s.withFile("cover", name));
    }

    /**
     * Enfileira o alinhamento palavra a palavra (usa a voz isolada + a letra).
     * Vazio se a música não existe; IllegalStateException se ainda não dá para alinhar.
     */
    public Optional<Song> requestWords(String id, String language) {
        Song updated = songs.computeIfPresent(id, (k, s) -> {
            if (s.status() != SongStatus.READY) {
                throw new IllegalStateException("A música ainda não terminou de ser separada");
            }
            if (!s.files().containsKey("lyrics")) {
                throw new IllegalStateException("Escolha uma letra sincronizada antes");
            }
            if (Song.WORDS_RUNNING.equals(s.wordsState())) {
                throw new IllegalStateException("O alinhamento já está em andamento");
            }
            return s.withWordsState(Song.WORDS_RUNNING, null);
        });
        if (updated == null) {
            return Optional.empty();
        }
        persist(updated);
        worker.submit(() -> alignWords(id, language));
        return Optional.of(updated);
    }

    private void alignWords(String id, String language) {
        Song song = songs.get(id);
        if (song == null) {
            return;
        }
        Path dir = root.resolve(id);
        Path lrc = dir.resolve("lyrics.lrc");
        Path words = dir.resolve("words.json");
        try {
            var lyricsStamp = Files.getLastModifiedTime(lrc);
            // novo: repassa o offset já detectado para essa música
            separator.align(dir.resolve(song.files().get("lead")), lrc, words,
                    language, song.lyricsOffsetMs());

            if (!Files.getLastModifiedTime(lrc).equals(lyricsStamp)) {
                Files.deleteIfExists(words);
                update(id, s -> s.withWordsState(null, null));
                return;
            }
            update(id, s -> s.withWordsReady("words.json"));
        } catch (Exception e) {
            log.error("Falha ao alinhar palavras de {}", id, e);
            String message = e.getMessage();
            update(id, s -> s.withWordsState(Song.WORDS_FAILED, message));
        }
    }

    // limites contra payloads absurdos (o editor manda a letra inteira de uma vez)
    private static final int MAX_LINES = 2000;
    private static final int MAX_WORDS_PER_LINE = 150;
    private static final int MAX_TEXT = 600;
    private static final double MIN_TIME = -60.0;     // o ajuste de sincronia pode empurrar para antes de zero
    private static final double MAX_TIME = 36000.0;

    /**
     * Grava palavras criadas à mão (editor de sincronia). Vazio se a música não existe;
     * IllegalStateException se não dá para salvar agora; IllegalArgumentException se o conteúdo é inválido.
     */
    public Optional<Song> saveWords(String id, WordsFile body) {
        Song song = songs.get(id);
        if (song == null) {
            return Optional.empty();
        }
        if (Song.WORDS_RUNNING.equals(song.wordsState())) {
            throw new IllegalStateException("O alinhamento automático ainda está rodando. Aguarde terminar.");
        }
        if (!song.files().containsKey("lyrics")) {
            throw new IllegalStateException("Escolha uma letra sincronizada antes");
        }
        validateWords(body);

        String language = body.language() != null && body.language().matches("[a-z]{2,3}") ? body.language() : "pt";
        WordsFile clean = new WordsFile(1, language, "manual", body.lines());

        Path dir = root.resolve(id);
        Path tmp = dir.resolve("words.json.tmp");
        Path target = dir.resolve("words.json");
        try {
            compactMapper.writeValue(tmp.toFile(), clean);
            try { // troca atômica: o player nunca lê o arquivo pela metade
                Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            } catch (AtomicMoveNotSupportedException e) {
                Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING);
            }
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
        return update(id, s -> s.withWordsReady("words.json"));
    }

    private static void validateWords(WordsFile file) {
        if (file == null || file.lines() == null || file.lines().isEmpty() || file.lines().size() > MAX_LINES) {
            throw new IllegalArgumentException("Lista de linhas inválida");
        }
        int n = 0;
        for (WordsFile.Line line : file.lines()) {
            n++;
            if (line == null || !validTime(line.t()) || line.text() == null || line.text().isBlank()
                    || line.text().length() > MAX_TEXT) {
                throw new IllegalArgumentException("Linha " + n + " inválida");
            }
            if (!line.aligned()) {
                if (line.words() != null && !line.words().isEmpty()) {
                    throw new IllegalArgumentException("Linha " + n + ": só linhas completas levam palavras");
                }
                continue;
            }
            String[] tokens = line.text().strip().split("(?U)\\s+");
            List<WordsFile.Word> words = line.words();
            if (words == null || words.size() != tokens.length || words.size() > MAX_WORDS_PER_LINE) {
                throw new IllegalArgumentException("Linha " + n + ": as palavras não batem com o texto");
            }
            double previousStart = Double.NEGATIVE_INFINITY;
            for (int k = 0; k < words.size(); k++) {
                WordsFile.Word w = words.get(k);
                if (w == null || !tokens[k].equals(w.w()) || !validTime(w.s()) || !validTime(w.e())
                        || w.e() < w.s() || w.s() < previousStart) {
                    throw new IllegalArgumentException("Linha " + n + ": palavra " + (k + 1) + " com tempo inválido");
                }
                previousStart = w.s();
            }
        }
    }

    private static boolean validTime(double t) {
        return Double.isFinite(t) && t >= MIN_TIME && t <= MAX_TIME;
    }

    public Optional<Song> setLyricsOffset(String id, int offsetMs) {
        int clamped = Math.max(-60_000, Math.min(60_000, offsetMs));
        return update(id, s -> s.withLyricsOffset(clamped));
    }

    // ---------------------------------------------------------------- internos

    private void enqueue(Song song) {
        songs.put(song.id(), song);
        worker.submit(() -> process(song.id()));
    }

    private void process(String id) {
        if (!songs.containsKey(id)) {
            return; // apagada enquanto esperava na fila
        }
        Path dir = root.resolve(id);
        try {
            update(id, s -> s.withStatus(SongStatus.SEPARATING));
            Path input = findOriginal(dir);
            Map<String, String> files = separator.separate(input, dir);
            update(id, s -> s.withReady(files));
        } catch (Exception e) {
            log.error("Falha ao processar {}", id, e);
            update(id, s -> s.withError(e.getMessage()));
        }
    }

    /** Altera a música de forma atômica no mapa e grava o meta.json. Vazio se ela foi apagada. */
    private Optional<Song> update(String id, UnaryOperator<Song> change) {
        Song updated = songs.computeIfPresent(id, (k, current) -> change.apply(current));
        if (updated != null) {
            persist(updated);
        }
        return Optional.ofNullable(updated);
    }

    private void persist(Song song) {
        songs.putIfAbsent(song.id(), song);
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
