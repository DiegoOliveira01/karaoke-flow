package dev.karaoke.model;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Metadados de uma música. Imutável: cada mudança gera uma nova instância,
 * que o SongService persiste em meta.json dentro da pasta da música.
 *
 * @param files          nome lógico -> arquivo ("instrumental", "lead", "backing", "lyrics", "cover")
 * @param lyricsOffsetMs atraso da letra em ms (positivo = letra aparece mais tarde)
 * @param rev            sobe a cada troca de letra/capa; vai na URL como ?v= para furar o cache do navegador
 */
public record Song(
        String id,
        String title,
        String artist,
        SongStatus status,
        String error,
        Instant createdAt,
        Map<String, String> files,
        int lyricsOffsetMs,
        int rev) {

    public Song {
        files = files == null ? Map.of() : Map.copyOf(files);
    }

    public Song withStatus(SongStatus newStatus) {
        return new Song(id, title, artist, newStatus, null, createdAt, files, lyricsOffsetMs, rev);
    }

    /** Junta os arquivos gerados pela separação aos que já existem (letra/capa). */
    public Song withReady(Map<String, String> generated) {
        return new Song(id, title, artist, SongStatus.READY, null, createdAt,
                merge(files, generated), lyricsOffsetMs, rev);
    }

    public Song withError(String message) {
        return new Song(id, title, artist, SongStatus.FAILED, message, createdAt, files, lyricsOffsetMs, rev);
    }

    /** Troca letra ou capa. Uma letra nova zera o ajuste de sincronia (era feito para a anterior). */
    public Song withFile(String key, String filename) {
        int offset = "lyrics".equals(key) ? 0 : lyricsOffsetMs;
        return new Song(id, title, artist, status, error, createdAt,
                merge(files, Map.of(key, filename)), offset, rev + 1);
    }

    public Song withLyricsOffset(int ms) {
        return new Song(id, title, artist, status, error, createdAt, files, ms, rev);
    }

    private static Map<String, String> merge(Map<String, String> a, Map<String, String> b) {
        Map<String, String> merged = new LinkedHashMap<>(a);
        merged.putAll(b);
        return merged;
    }
}
