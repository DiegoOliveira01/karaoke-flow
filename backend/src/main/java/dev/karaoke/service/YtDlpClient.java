package dev.karaoke.service;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * Chama o yt-dlp para buscar e baixar áudio do YouTube.
 *
 * Aceita tanto uma URL completa ("https://youtube.com/watch?v=...") quanto um
 * termo de busca livre ("Artista - Título"). No segundo caso, usa "ytsearchN:"
 * para pegar os N primeiros resultados.
 *
 * Se o arquivo de cookies existir (configurável em karaoke.ytdlp.cookies), o
 * yt-dlp é chamado com --cookies, o que resolve o "Sign in to confirm you're
 * not a bot" que o YouTube passou a exigir em 2024/2025. O arquivo é exportado
 * uma vez com a extensão "Get cookies.txt LOCALLY" e renovado quando expira.
 *
 * Requer yt-dlp e ffmpeg instalados e disponíveis no PATH (ou configurados em
 * karaoke.ytdlp.path). Recomendado: instalar o Deno (irm https://deno.land/install.ps1 | iex)
 * para habilitar o runtime JS que o YouTube agora usa para decifrar proteções.
 */
@Component
public class YtDlpClient {

    private static final Logger log = LoggerFactory.getLogger(YtDlpClient.class);
    private static final long TIMEOUT_SECONDS = 900; // 15 min: downloads longos ainda cabem
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private final String executable;
    private final String cookiesPath;

    public YtDlpClient(
            @Value("${karaoke.ytdlp.path:yt-dlp}") String executable,
            @Value("${karaoke.ytdlp.cookies:}") String cookiesPath) {
        this.executable = executable;
        this.cookiesPath = cookiesPath == null ? "" : cookiesPath.trim();
    }

    public record Metadata(String title, String artist) {}

    public record Candidate(
            String videoId,
            String url,
            String title,
            String suggestedTitle,
            String suggestedArtist,
            String channel,
            int durationSec,
            String thumbnail) {}

    // ---------------------------------------------------------------- comandos

    /**
     * Monta o começo do comando: executável + flags comuns.
     * Adiciona --cookies se o arquivo existir (silenciosamente ignora se não).
     */
    private List<String> baseCmd() {
        List<String> cmd = new ArrayList<>();
        cmd.add(executable);
        cmd.add("--no-playlist");
        if (!cookiesPath.isBlank() && Files.isRegularFile(Path.of(cookiesPath))) {
            cmd.add("--cookies");
            cmd.add(cookiesPath);
        }
        return cmd;
    }

    // ---------------------------------------------------------------- operações

    /** Consulta título e uploader sem baixar nada. */
    public Metadata probe(String urlOrQuery) throws IOException, InterruptedException {
        String target = normalizeTarget(urlOrQuery);
        List<String> cmd = baseCmd();
        cmd.add("--skip-download");
        cmd.add("--no-warnings");
        cmd.add("--print");
        cmd.add("%(title)s\u0001%(uploader)s");
        cmd.add(target);

        String out = runCapture(cmd);
        String last = out.lines().filter(l -> !l.isBlank()).reduce((a, b) -> b).orElse("");
        String[] parts = last.split("\u0001", 2);
        String title = parts.length > 0 && !parts[0].isBlank() ? parts[0].trim() : "";
        String artist = parts.length > 1 && !parts[1].isBlank() ? parts[1].trim() : "";
        return new Metadata(title, artist);
    }

    /**
     * Busca N resultados e devolve o metadado de cada um, sem baixar nada.
     * Cada resultado já traz uma sugestão limpa de título/artista.
     */
    public List<Candidate> search(String query, int limit) throws IOException, InterruptedException {
        String target = "ytsearch" + limit + ":" + query.trim();
        List<String> cmd = baseCmd();
        cmd.add("--flat-playlist");
        cmd.add("--dump-json");
        cmd.add("--no-warnings");
        cmd.add(target);

        String out = runCapture(cmd);

        List<Candidate> result = new ArrayList<>();
        for (String line : out.split("\\R")) {
            if (line.isBlank()) continue;
            try {
                JsonNode node = MAPPER.readTree(line);
                String id = textOr(node, "id");
                String url = textOr(node, "webpage_url");
                if (url == null || url.isBlank()) {
                    url = id == null ? null : "https://www.youtube.com/watch?v=" + id;
                }
                if (url == null) continue;

                String title = textOr(node, "title");
                String channel = firstNonBlank(
                        textOr(node, "uploader"),
                        textOr(node, "channel"),
                        textOr(node, "uploader_id"));
                int duration = node.hasNonNull("duration")
                        ? (int) Math.round(node.get("duration").asDouble()) : 0;
                String thumb = pickThumbnail(node);

                var guess = suggestMeta(title, channel);
                result.add(new Candidate(id, url, title, guess.title(), guess.artist(),
                        channel, duration, thumb));
            } catch (Exception e) {
                log.warn("Ignorando resultado malformado do yt-dlp: {}", e.getMessage());
            }
        }
        return result;
    }

    /**
     * Baixa o áudio em MP3 no caminho indicado (sem extensão; o yt-dlp adiciona).
     * Ex.: passar ".../original" gera ".../original.mp3".
     */
    public void download(String urlOrQuery, Path outputWithoutExt) throws IOException, InterruptedException {
        String target = normalizeTarget(urlOrQuery);
        Path template = outputWithoutExt.resolveSibling(
                outputWithoutExt.getFileName() + ".%(ext)s");
        List<String> cmd = baseCmd();
        cmd.add("--no-write-info-json");
        cmd.add("-x");
        cmd.add("--audio-format");
        cmd.add("mp3");
        cmd.add("-o");
        cmd.add(template.toString());
        cmd.add(target);

        runInherit(cmd);
    }

    // ---------------------------------------------------------------- internos

    private String normalizeTarget(String urlOrQuery) {
        String s = urlOrQuery.trim();
        if (s.startsWith("http://") || s.startsWith("https://")) {
            return s;
        }
        return "ytsearch1:" + s;
    }

    private static String textOr(JsonNode n, String field) {
        return n.hasNonNull(field) ? n.get(field).asText("").trim() : null;
    }

    private static String firstNonBlank(String... values) {
        for (String v : values) if (v != null && !v.isBlank()) return v;
        return "";
    }

    private static String pickThumbnail(JsonNode n) {
        if (n.hasNonNull("thumbnail")) return n.get("thumbnail").asText();
        if (n.has("thumbnails") && n.get("thumbnails").isArray() && n.get("thumbnails").size() > 0) {
            JsonNode last = n.get("thumbnails").get(n.get("thumbnails").size() - 1);
            if (last.hasNonNull("url")) return last.get("url").asText();
        }
        return null;
    }

    /**
     * Tenta adivinhar título e artista a partir do título do vídeo e do canal.
     * Regras:
     *   - "Artista - Título" no título vira {artist, title}
     *   - canais "- Topic", "VEVO", "Official" perdem o sufixo
     */
    private static Metadata suggestMeta(String title, String channel) {
        String t = title == null ? "" : title.trim();
        String c = channel == null ? "" : channel.trim();

        c = c.replaceAll("\\s*-\\s*Topic$", "")
             .replaceAll("\\s*VEVO$", "")
             .replaceAll("\\s*Official$", "")
             .trim();

        var m = java.util.regex.Pattern
                .compile("^(.+?)\\s*[-–—]\\s*(.+)$")
                .matcher(t);
        if (m.matches()) {
            String a = m.group(1).trim();
            String s = m.group(2).trim();
            if (!c.isBlank() && a.equalsIgnoreCase(c)) {
                return new Metadata(s, c);
            }
            return new Metadata(s, a);
        }
        return new Metadata(t, c);
    }

    /** Roda o comando capturando a saída (usado no probe/search, que produzem texto). */
    private String runCapture(List<String> cmd) throws IOException, InterruptedException {
        log.info("yt-dlp: {}", String.join(" ", cmd));
        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.redirectErrorStream(true);
        Process p = pb.start();
        byte[] out = p.getInputStream().readAllBytes();
        if (!p.waitFor(TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
            p.destroyForcibly();
            throw new IOException("yt-dlp demorou mais de " + TIMEOUT_SECONDS + "s");
        }
        String text = new String(out, StandardCharsets.UTF_8);
        if (p.exitValue() != 0) {
            throw new IOException("yt-dlp falhou (código " + p.exitValue() + "): " + text);
        }
        return text;
    }

    /** Roda o comando deixando o progresso aparecer no console do Spring Boot. */
    private void runInherit(List<String> cmd) throws IOException, InterruptedException {
        log.info("yt-dlp: {}", String.join(" ", cmd));
        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.inheritIO();
        Process p = pb.start();
        if (!p.waitFor(TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
            p.destroyForcibly();
            throw new IOException("yt-dlp demorou mais de " + TIMEOUT_SECONDS + "s");
        }
        if (p.exitValue() != 0) {
            throw new IOException("yt-dlp falhou (código " + p.exitValue() + ")");
        }
    }
}