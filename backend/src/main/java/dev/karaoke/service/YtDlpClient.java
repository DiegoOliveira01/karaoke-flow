package dev.karaoke.service;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.TimeUnit;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * Chama o yt-dlp para baixar o áudio de um vídeo do YouTube.
 *
 * Aceita tanto uma URL completa ("https://youtube.com/watch?v=...") quanto um
 * termo de busca livre ("Artista - Título"). No segundo caso, usa "ytsearch1:"
 * para pegar o primeiro resultado.
 *
 * Requer yt-dlp e ffmpeg instalados e disponíveis no PATH (ou configurados em
 * karaoke.ytdlp.path).
 */
@Component
public class YtDlpClient {

    private static final Logger log = LoggerFactory.getLogger(YtDlpClient.class);
    private static final long TIMEOUT_SECONDS = 900; // 15 min: downloads longos ainda cabem

    private final String executable;

    public YtDlpClient(@Value("${karaoke.ytdlp.path:yt-dlp}") String executable) {
        this.executable = executable;
    }

    public record Metadata(String title, String artist) {}

    /** Consulta título e uploader sem baixar nada. */
    public Metadata probe(String urlOrQuery) throws IOException, InterruptedException {
        String target = normalizeTarget(urlOrQuery);
        List<String> cmd = List.of(
                executable,
                "--no-playlist",
                "--skip-download",
                "--no-warnings",
                "--print", "%(title)s\u0001%(uploader)s",
                target);
        String out = runCapture(cmd);
        String last = out.lines().filter(l -> !l.isBlank()).reduce((a, b) -> b).orElse("");
        String[] parts = last.split("\u0001", 2);
        String title = parts.length > 0 && !parts[0].isBlank() ? parts[0].trim() : "";
        String artist = parts.length > 1 && !parts[1].isBlank() ? parts[1].trim() : "";
        return new Metadata(title, artist);
    }

    /**
     * Baixa o áudio em MP3 no caminho indicado (sem extensão; o yt-dlp adiciona).
     * Ex.: passar ".../original" gera ".../original.mp3".
     */
    public void download(String urlOrQuery, Path outputWithoutExt) throws IOException, InterruptedException {
        String target = normalizeTarget(urlOrQuery);
        Path template = outputWithoutExt.resolveSibling(
                outputWithoutExt.getFileName() + ".%(ext)s");
        List<String> cmd = List.of(
                executable,
                "--no-playlist",
                "--no-write-info-json",
                "-x", "--audio-format", "mp3",
                "-o", template.toString(),
                target);
        runInherit(cmd);
    }

    private String normalizeTarget(String urlOrQuery) {
        String s = urlOrQuery.trim();
        if (s.startsWith("http://") || s.startsWith("https://")) {
            return s;
        }
        return "ytsearch1:" + s;
    }

    /** Roda o comando capturando a saída (usado no probe, que produz pouco texto). */
    private String runCapture(List<String> cmd) throws IOException, InterruptedException {
        log.info("yt-dlp (probe): {}", String.join(" ", cmd));
        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.redirectErrorStream(true); // junta stderr no stdout para evitar deadlock
        Process p = pb.start();
        byte[] out = p.getInputStream().readAllBytes();
        if (!p.waitFor(TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
            p.destroyForcibly();
            throw new IOException("yt-dlp demorou mais de " + TIMEOUT_SECONDS + "s (probe)");
        }
        String text = new String(out, StandardCharsets.UTF_8);
        if (p.exitValue() != 0) {
            throw new IOException("yt-dlp probe falhou (código " + p.exitValue() + "): " + text);
        }
        return text;
    }

    /** Roda o comando deixando o progresso aparecer no console do Spring Boot. */
    private void runInherit(List<String> cmd) throws IOException, InterruptedException {
        log.info("yt-dlp (download): {}", String.join(" ", cmd));
        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.inheritIO();
        Process p = pb.start();
        if (!p.waitFor(TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
            p.destroyForcibly();
            throw new IOException("yt-dlp demorou mais de " + TIMEOUT_SECONDS + "s (download)");
        }
        if (p.exitValue() != 0) {
            throw new IOException("yt-dlp download falhou (código " + p.exitValue() + ")");
        }
    }
}